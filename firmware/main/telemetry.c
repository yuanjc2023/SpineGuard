#include "telemetry.h"

#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "device_commands.h"
#include "device_config.h"
#include "device_health.h"
#include "device_identity.h"
#include "esp_http_client.h"
#include "esp_system.h"
#include "esp_log.h"
#include "esp_random.h"
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#include "esp_crt_bundle.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "motor_control.h"
#include "posture_model.h"
#include "sdkconfig.h"
#include "wifi_manager.h"

#define TELEMETRY_TASK_STACK_SIZE 8192
#define TELEMETRY_TASK_PRIORITY 4
#define TELEMETRY_JSON_BUFFER_SIZE 5120
#define SESSION_EMPTY_END_MS 3000LL
#define SESSION_ID_SIZE 96

static const char *TAG = "telemetry";

typedef struct {
    bool valid;
    fsr_frame_t fsr;
    vl53l1x_sample_t tof;
    posture_class_t stable_posture;
    float stable_confidence;
    posture_alert_status_t alert;
    uint64_t sitting_duration_s;
    char session_id[SESSION_ID_SIZE];
} telemetry_snapshot_t;

static SemaphoreHandle_t s_mutex;
static telemetry_snapshot_t s_snapshot;
static bool s_session_active;
static int64_t s_sitting_started_ms;
static int64_t s_empty_since_ms;
static uint32_t s_session_counter;
static uint32_t s_boot_nonce;
static uint32_t s_seq;
static char s_session_id[SESSION_ID_SIZE];
static char s_json_buffer[TELEMETRY_JSON_BUFFER_SIZE];

static int clamp_int(int value, int minimum, int maximum)
{
    if (value < minimum) {
        return minimum;
    }
    if (value > maximum) {
        return maximum;
    }
    return value;
}

static float clamp_float(float value, float minimum, float maximum)
{
    if (value < minimum) {
        return minimum;
    }
    if (value > maximum) {
        return maximum;
    }
    return value;
}

static void create_session_id(int64_t device_time_ms)
{
    const int64_t timestamp_ms = wifi_manager_time_is_valid()
        ? wifi_manager_unix_timestamp_ms()
        : device_time_ms;
    snprintf(
        s_session_id,
        sizeof(s_session_id),
        "%s-%lld-%08lX-%lu",
        device_identity_id(),
        (long long)timestamp_ms,
        (unsigned long)s_boot_nonce,
        (unsigned long)++s_session_counter
    );
    s_seq = 0;
}

static void update_session_locked(const fsr_frame_t *fsr)
{
    const int64_t now_ms = fsr->device_time_ms;
    if (fsr->occupied) {
        s_empty_since_ms = 0;
        if (!s_session_active) {
            s_session_active = true;
            s_sitting_started_ms = now_ms;
            create_session_id(now_ms);
        }
    } else if (s_session_active) {
        if (s_empty_since_ms == 0) {
            s_empty_since_ms = now_ms;
        }
        if (now_ms - s_empty_since_ms >= SESSION_EMPTY_END_MS) {
            s_session_active = false;
            s_sitting_started_ms = 0;
            s_empty_since_ms = 0;
        }
    }
}

void telemetry_update_snapshot(
    const fsr_frame_t *fsr,
    const vl53l1x_sample_t *tof,
    posture_class_t stable_posture,
    float stable_confidence,
    const posture_alert_status_t *alert
)
{
    if (s_mutex == NULL || fsr == NULL || tof == NULL || alert == NULL) {
        return;
    }
    if (xSemaphoreTake(s_mutex, 0) != pdTRUE) {
        return;
    }

    update_session_locked(fsr);
    memset(&s_snapshot, 0, sizeof(s_snapshot));
    s_snapshot.valid = true;
    s_snapshot.fsr = *fsr;
    s_snapshot.tof = *tof;
    s_snapshot.stable_posture = stable_posture;
    s_snapshot.stable_confidence = clamp_float(stable_confidence, 0.0f, 1.0f);
    s_snapshot.alert = *alert;
    s_snapshot.sitting_duration_s = s_session_active && s_sitting_started_ms > 0
        ? (uint64_t)(fsr->device_time_ms - s_sitting_started_ms) / 1000ULL
        : 0;
    if (s_session_id[0] == '\0') {
        create_session_id(fsr->device_time_ms);
    }
    snprintf(s_snapshot.session_id, sizeof(s_snapshot.session_id), "%s", s_session_id);
    xSemaphoreGive(s_mutex);
}

static bool take_snapshot(telemetry_snapshot_t *out, uint32_t *seq)
{
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
    const bool valid = s_snapshot.valid;
    if (valid) {
        *out = s_snapshot;
        *seq = ++s_seq;
    }
    xSemaphoreGive(s_mutex);
    return valid;
}

static void pressure_values(const fsr_frame_t *fsr, int pressure[FSR_COUNT])
{
    memset(pressure, 0, sizeof(int) * FSR_COUNT);
    if (!fsr->ratio_valid) {
        return;
    }

    int sum = 0;
    int largest = 0;
    for (int i = 0; i < FSR_COUNT; ++i) {
        pressure[i] = clamp_int((int)lroundf(fsr->calibrated_ratio[i] * 1000.0f), 0, 1000);
        sum += pressure[i];
        if (pressure[i] > pressure[largest]) {
            largest = i;
        }
    }
    pressure[largest] = clamp_int(pressure[largest] + (1000 - sum), 0, 1000);
}

static const char *recognition_source(posture_class_t posture)
{
    return posture >= POSTURE_NORMAL && posture <= POSTURE_BACK_LEAN
        ? "lightgbm"
        : "rule";
}

static cJSON *build_json(
    const telemetry_snapshot_t *snapshot,
    uint32_t seq,
    int64_t timestamp_ms
)
{
    int pressure[FSR_COUNT];
    pressure_values(&snapshot->fsr, pressure);

    const int left_right_diff = pressure[FSR_LEFT] - pressure[FSR_RIGHT];
    const int front_back_diff = pressure[FSR_FRONT] - pressure[FSR_BACK];
    const int left_right_sum = pressure[FSR_LEFT] + pressure[FSR_RIGHT];
    const int front_back_sum = pressure[FSR_FRONT] + pressure[FSR_BACK];
    const float center_x = left_right_sum > 0
        ? (float)left_right_diff / (float)left_right_sum
        : 0.0f;
    const float center_y = front_back_sum > 0
        ? (float)front_back_diff / (float)front_back_sum
        : 0.0f;
    const float asymmetry = clamp_float(
        (float)(abs(left_right_diff) + abs(front_back_diff)) / 1000.0f,
        0.0f,
        1.0f
    );

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return NULL;
    }
    cJSON_AddNumberToObject(root, "protocol_version", 2);
    char device_name[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    device_identity_copy_name(device_name, sizeof(device_name));
    cJSON_AddStringToObject(root, "device_id", device_identity_id());
    cJSON_AddStringToObject(root, "device_name", device_name);
    cJSON_AddStringToObject(root, "session_id", snapshot->session_id);
    cJSON_AddNumberToObject(root, "seq", seq);
    cJSON_AddNumberToObject(root, "timestamp_ms", (double)timestamp_ms);

    cJSON_AddBoolToObject(root, "occupied", snapshot->fsr.occupied);
    cJSON_AddBoolToObject(root, "ratio_valid", snapshot->fsr.ratio_valid);
    cJSON_AddStringToObject(root, "posture", posture_model_label(snapshot->stable_posture));
    cJSON_AddNumberToObject(root, "confidence", snapshot->stable_confidence);
    cJSON_AddStringToObject(root, "recognition_source", recognition_source(snapshot->stable_posture));
    cJSON_AddStringToObject(root, "model_version", POSTURE_MODEL_VERSION);

    cJSON *pressure_json = cJSON_AddObjectToObject(root, "pressure");
    cJSON_AddNumberToObject(pressure_json, "left", pressure[FSR_LEFT]);
    cJSON_AddNumberToObject(pressure_json, "right", pressure[FSR_RIGHT]);
    cJSON_AddNumberToObject(pressure_json, "front", pressure[FSR_FRONT]);
    cJSON_AddNumberToObject(pressure_json, "back", pressure[FSR_BACK]);
    cJSON_AddNumberToObject(pressure_json, "center", pressure[FSR_CENTER]);

    cJSON *raw = cJSON_AddObjectToObject(root, "raw_pressure");
    cJSON_AddNumberToObject(raw, "left", snapshot->fsr.raw_adc[FSR_LEFT]);
    cJSON_AddNumberToObject(raw, "right", snapshot->fsr.raw_adc[FSR_RIGHT]);
    cJSON_AddNumberToObject(raw, "front", snapshot->fsr.raw_adc[FSR_FRONT]);
    cJSON_AddNumberToObject(raw, "back", snapshot->fsr.raw_adc[FSR_BACK]);
    cJSON_AddNumberToObject(raw, "center", snapshot->fsr.raw_adc[FSR_CENTER]);

    cJSON *features = cJSON_AddObjectToObject(root, "pressure_features");
    cJSON_AddNumberToObject(
        features,
        "total_pressure",
        clamp_int((int)lroundf(snapshot->fsr.total_calibrated_g), 0, 7500)
    );
    cJSON_AddNumberToObject(features, "left_right_diff", left_right_diff);
    cJSON_AddNumberToObject(features, "front_back_diff", front_back_diff);
    cJSON_AddNumberToObject(features, "center_x", center_x);
    cJSON_AddNumberToObject(features, "center_y", center_y);
    cJSON_AddNumberToObject(features, "asymmetry_index", asymmetry);

    cJSON *backrest = cJSON_AddObjectToObject(root, "backrest");
    cJSON_AddBoolToObject(backrest, "online", snapshot->tof.online);
    cJSON_AddBoolToObject(backrest, "data_ready", snapshot->tof.data_ready);
    cJSON_AddBoolToObject(backrest, "valid", snapshot->tof.valid);
    if (snapshot->tof.valid && isfinite(snapshot->tof.distance_filtered_mm)) {
        cJSON_AddNumberToObject(backrest, "distance_mm", snapshot->tof.distance_filtered_mm);
    } else {
        cJSON_AddNullToObject(backrest, "distance_mm");
    }
    cJSON_AddNumberToObject(backrest, "range_status", snapshot->tof.range_status);

    cJSON_AddNumberToObject(root, "posture_duration_s", (double)snapshot->alert.stable_duration_s);
    cJSON_AddNumberToObject(root, "sitting_duration_s", (double)snapshot->sitting_duration_s);

    device_runtime_config_t runtime_config;
    device_config_get(&runtime_config);
    cJSON_AddNumberToObject(root, "applied_config_version", runtime_config.applied_config_version);
    cJSON_AddBoolToObject(root, "vibration_enabled", runtime_config.vibration_enabled);
    cJSON_AddBoolToObject(root, "vibration_effective_enabled", device_config_effective_vibration_enabled(&runtime_config));
    cJSON_AddBoolToObject(root, "warning_active", snapshot->alert.warning_active);
    cJSON_AddBoolToObject(root, "reminder_due", snapshot->alert.reminder_due);
    cJSON_AddBoolToObject(root, "reminder_suppressed", snapshot->alert.reminder_suppressed);
    cJSON_AddBoolToObject(root, "vibration_active", snapshot->alert.vibration_active);
    const char *position = motor_control_active_position();
    if (position != NULL) cJSON_AddStringToObject(root, "vibration_position", position);
    else cJSON_AddNullToObject(root, "vibration_position");
    cJSON_AddNumberToObject(root, "reminder_count", snapshot->alert.reminder_count);
    cJSON_AddNumberToObject(root, "reminder_cooldown_remaining_s", snapshot->alert.cooldown_remaining_s);
    cJSON *reminder = cJSON_AddObjectToObject(root, "reminder_config");
    cJSON_AddStringToObject(reminder, "mode", reminder_mode_name(runtime_config.mode));
    cJSON_AddNumberToObject(reminder, "trigger_duration_s", runtime_config.trigger_duration_s);
    cJSON_AddNumberToObject(reminder, "vibration_duration_s", runtime_config.vibration_duration_s);
    cJSON_AddNumberToObject(reminder, "cooldown_s", runtime_config.cooldown_s);
    cJSON_AddNumberToObject(reminder, "intensity_percent", motor_control_intensity_percent());

    cJSON_AddNullToObject(root, "battery_level");
    cJSON_AddStringToObject(root, "power_source", CONFIG_SPINEGUARD_POWER_SOURCE);
    const int32_t rssi = wifi_manager_get_rssi_dbm();
    if (rssi == INT32_MIN) {
        cJSON_AddNullToObject(root, "wifi_rssi_dbm");
    } else {
        cJSON_AddNumberToObject(root, "wifi_rssi_dbm", rssi);
    }

    device_health_snapshot_t health;
    device_health_get_snapshot(&health);
    cJSON *sensor_status = cJSON_AddObjectToObject(root, "sensor_status");
    cJSON *fsr_status = cJSON_AddObjectToObject(sensor_status, "fsr");
    cJSON_AddStringToObject(fsr_status, "left", fsr_health_name(health.fsr[FSR_LEFT]));
    cJSON_AddStringToObject(fsr_status, "right", fsr_health_name(health.fsr[FSR_RIGHT]));
    cJSON_AddStringToObject(fsr_status, "front", fsr_health_name(health.fsr[FSR_FRONT]));
    cJSON_AddStringToObject(fsr_status, "back", fsr_health_name(health.fsr[FSR_BACK]));
    cJSON_AddStringToObject(fsr_status, "center", fsr_health_name(health.fsr[FSR_CENTER]));
    cJSON_AddBoolToObject(fsr_status, "all_ok", health.fsr_all_ok);
    cJSON_AddBoolToObject(fsr_status, "baseline_valid", health.baseline_valid);
    cJSON *tof_status = cJSON_AddObjectToObject(sensor_status, "tof");
    cJSON_AddBoolToObject(tof_status, "online", health.tof_online);
    cJSON_AddBoolToObject(tof_status, "valid", health.tof_valid);
    cJSON *motor_status = cJSON_AddObjectToObject(sensor_status, "motor");
    cJSON_AddBoolToObject(motor_status, "control_ready", health.motor_control_ready);
    cJSON_AddBoolToObject(motor_status, "self_test_completed", health.motor_self_test_completed);
    cJSON_AddBoolToObject(motor_status, "power_verified", health.motor_power_verified);

    device_command_status_t command_status;
    device_commands_get_status(&command_status);
    cJSON *command = cJSON_AddObjectToObject(root, "command_status");
    if (command_status.id[0] != '\0') cJSON_AddStringToObject(command, "id", command_status.id);
    else cJSON_AddNullToObject(command, "id");
    cJSON_AddStringToObject(command, "type", device_command_type_name(command_status.type));
    cJSON_AddStringToObject(command, "status", device_command_status_name(command_status.status));
    cJSON_AddNumberToObject(command, "progress_percent", command_status.progress_percent);
    if (command_status.error[0] != '\0') cJSON_AddStringToObject(command, "error", command_status.error);
    else cJSON_AddNullToObject(command, "error");

    cJSON_AddStringToObject(root, "device_credential_mode", "per_device_secret");
    cJSON_AddStringToObject(root, "firmware_version", CONFIG_SPINEGUARD_FIRMWARE_VERSION);
    return root;
}

static esp_err_t upload_json(const char *json)
{
    char url[320];
    const int written = snprintf(
        url,
        sizeof(url),
        "%s/device/telemetry",
        wifi_manager_backend_base_url()
    );
    if (written < 0 || written >= (int)sizeof(url)) {
        return ESP_ERR_INVALID_SIZE;
    }

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
    config.crt_bundle_attach = esp_crt_bundle_attach;
#endif
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Device-ID", device_identity_id());
    char secret[SPINEGUARD_DEVICE_SECRET_CAPACITY] = {0};
    device_identity_copy_secret(secret, sizeof(secret));
    esp_http_client_set_header(client, "X-Device-Token", secret);
    esp_http_client_set_post_field(client, json, strlen(json));

    const esp_err_t err = esp_http_client_perform(client);
    const int status = err == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    if (err == ESP_OK && status >= 200 && status < 300) {
        ESP_LOGI(TAG, "Telemetry uploaded: seq=%" PRIu32 " HTTP %d", s_seq, status);
        esp_http_client_cleanup(client);
        return ESP_OK;
    }

    ESP_LOGW(TAG, "Telemetry failed: err=%s HTTP %d", esp_err_to_name(err), status);
    esp_http_client_cleanup(client);
    return err == ESP_OK ? ESP_FAIL : err;
}

static void telemetry_task(void *arg)
{
    (void)arg;
    TickType_t last_wake = xTaskGetTickCount();
    while (true) {
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(CONFIG_SPINEGUARD_TELEMETRY_INTERVAL_MS));
        if (!wifi_manager_is_connected() || !wifi_manager_time_is_valid()) {
            continue;
        }

        telemetry_snapshot_t snapshot;
        uint32_t seq = 0;
        if (!take_snapshot(&snapshot, &seq)) {
            continue;
        }

        cJSON *root = build_json(&snapshot, seq, wifi_manager_unix_timestamp_ms());
        if (root == NULL) {
            ESP_LOGE(TAG, "Unable to allocate telemetry JSON");
            continue;
        }
        const bool printed = cJSON_PrintPreallocated(
            root,
            s_json_buffer,
            sizeof(s_json_buffer),
            false
        );
        cJSON_Delete(root);
        if (!printed) {
            ESP_LOGE(TAG, "Telemetry JSON exceeds %u bytes", (unsigned)sizeof(s_json_buffer));
            continue;
        }
        upload_json(s_json_buffer);
    }
}

esp_err_t telemetry_start(void)
{
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    memset(&s_snapshot, 0, sizeof(s_snapshot));
    s_boot_nonce = esp_random();
    create_session_id(0);

    const BaseType_t created = xTaskCreate(
        telemetry_task,
        "telemetry",
        TELEMETRY_TASK_STACK_SIZE,
        NULL,
        TELEMETRY_TASK_PRIORITY,
        NULL
    );
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
