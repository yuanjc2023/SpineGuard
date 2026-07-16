#include <inttypes.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_adc/adc_oneshot.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#ifdef CONFIG_SPINEGUARD_VIBRATION_ENABLED
#define SPINEGUARD_VIBRATION_JSON "true"
#else
#define SPINEGUARD_VIBRATION_JSON "false"
#endif

#define SAMPLE_COUNT 16
#define WIFI_CONNECTED_BIT BIT0
#define JSON_BUFFER_SIZE 1280
#define SESSION_ID_SIZE 96
#define SPINEGUARD_TASK_STACK_SIZE (12 * 1024)
#define SPINEGUARD_TASK_PRIORITY 5

/* Initial thresholds only; calibrate them with real seated-posture data. */
#define EMPTY_PRESSURE_THRESHOLD 150
#define POSTURE_OFFSET_THRESHOLD 0.20
#define BAD_POSTURE_WARNING_SECONDS 30
#define SAMPLE_INTERVAL_MS 200
#define UPLOAD_INTERVAL_MS 2000

typedef struct {
    adc_channel_t channel;
    const char *name;
    int empty_raw;
    int pressed_raw;
} fsr_calibration_t;

typedef struct {
    int left;
    int right;
    int front;
    int back;
    int center;
} pressure_values_t;

typedef struct {
    int left;
    int right;
    int front;
    int back;
    int center;
} raw_pressure_values_t;

typedef struct {
    int total_pressure;
    int left_right_diff;
    int front_back_diff;
    double center_x;
    double center_y;
    double asymmetry_index;
} pressure_features_t;

/* Per-channel calibration values; update each pair after hardware calibration. */
static const fsr_calibration_t s_fsr[] = {
    { ADC_CHANNEL_3, "left",   4095, 0 }, /* GPIO4 / ADC1_CH3 */
    { ADC_CHANNEL_4, "right",  4095, 0 }, /* GPIO5 / ADC1_CH4 */
    { ADC_CHANNEL_5, "front",  4095, 0 }, /* GPIO6 / ADC1_CH5 */
    { ADC_CHANNEL_6, "back",   4095, 0 }, /* GPIO7 / ADC1_CH6 */
    { ADC_CHANNEL_7, "center", 4095, 0 }, /* GPIO8 / ADC1_CH7 */
};

static const char *TAG = "spineguard";
static EventGroupHandle_t s_wifi_bits;
static bool s_sntp_started;
static uint32_t s_seq;
static char s_session_id[SESSION_ID_SIZE];
static char s_json_buffer[JSON_BUFFER_SIZE];
static wifi_config_t s_wifi_config;

static void log_stack_watermark(const char *stage)
{
    ESP_LOGI(
        TAG,
        "Stack free at %s: %u bytes",
        stage,
        (unsigned int)uxTaskGetStackHighWaterMark(NULL));
}

static int clamp_int(int value, int lower, int upper)
{
    if (value < lower) {
        return lower;
    }
    if (value > upper) {
        return upper;
    }
    return value;
}

static double clamp_double(double value, double lower, double upper)
{
    if (value < lower) {
        return lower;
    }
    if (value > upper) {
        return upper;
    }
    return value;
}

static int read_avg(adc_oneshot_unit_handle_t handle, adc_channel_t channel)
{
    int sum = 0;
    for (int i = 0; i < SAMPLE_COUNT; i++) {
        int raw = 0;
        ESP_ERROR_CHECK(adc_oneshot_read(handle, channel, &raw));
        sum += raw;
    }
    return sum / SAMPLE_COUNT;
}

static int normalize_fsr(int raw, const fsr_calibration_t *calibration)
{
    int span = calibration->empty_raw - calibration->pressed_raw;
    if (span <= 0) {
        ESP_LOGE(TAG, "Invalid %s FSR calibration", calibration->name);
        return 0;
    }

    int normalized = ((calibration->empty_raw - raw) * 1000) / span;
    return clamp_int(normalized, 0, 1000);
}

static pressure_features_t calculate_features(const pressure_values_t *pressure)
{
    pressure_features_t features = {
        .total_pressure = clamp_int(
            pressure->left + pressure->right + pressure->front + pressure->back + pressure->center,
            0,
            5000),
        .left_right_diff = clamp_int(pressure->left - pressure->right, -1000, 1000),
        .front_back_diff = clamp_int(pressure->front - pressure->back, -1000, 1000),
        .center_x = 0.0,
        .center_y = 0.0,
        .asymmetry_index = 0.0,
    };
    int left_right_sum = pressure->left + pressure->right;
    int front_back_sum = pressure->front + pressure->back;

    if (left_right_sum > 0) {
        features.center_x = clamp_double(
            (double)features.left_right_diff / (double)left_right_sum, -1.0, 1.0);
    }
    if (front_back_sum > 0) {
        features.center_y = clamp_double(
            (double)features.front_back_diff / (double)front_back_sum, -1.0, 1.0);
    }
    if (features.total_pressure > 0) {
        features.asymmetry_index = clamp_double(
            (double)(abs(features.left_right_diff) + abs(features.front_back_diff)) /
                (double)features.total_pressure,
            0.0,
            1.0);
    }
    return features;
}

static const char *classify_posture(const pressure_features_t *features)
{
    double abs_x = fabs(features->center_x);
    double abs_y = fabs(features->center_y);

    if (features->total_pressure < EMPTY_PRESSURE_THRESHOLD) {
        return "empty";
    }
    if (abs_x >= POSTURE_OFFSET_THRESHOLD || abs_y >= POSTURE_OFFSET_THRESHOLD) {
        if (abs_x >= abs_y) {
            return features->center_x > 0.0 ? "left_lean" : "right_lean";
        }
        return features->center_y > 0.0 ? "front_lean" : "back_lean";
    }
    return "normal";
}

static double rule_confidence(const char *posture, const pressure_features_t *features)
{
    double offset = fmax(fabs(features->center_x), fabs(features->center_y));
    if (strcmp(posture, "empty") == 0) {
        return clamp_double(
            (double)(EMPTY_PRESSURE_THRESHOLD - features->total_pressure) /
                (double)EMPTY_PRESSURE_THRESHOLD,
            0.0,
            1.0);
    }
    if (strcmp(posture, "normal") == 0) {
        return clamp_double(1.0 - offset / POSTURE_OFFSET_THRESHOLD, 0.0, 1.0);
    }
    return clamp_double(offset, 0.0, 1.0);
}

static bool posture_is_bad(const char *posture)
{
    return strcmp(posture, "left_lean") == 0 || strcmp(posture, "right_lean") == 0 ||
        strcmp(posture, "front_lean") == 0 || strcmp(posture, "back_lean") == 0;
}

static bool unix_time_valid(void)
{
    return time(NULL) >= 1700000000;
}

static int64_t unix_timestamp_ms(void)
{
    struct timeval now;
    gettimeofday(&now, NULL);
    return (int64_t)now.tv_sec * 1000 + now.tv_usec / 1000;
}

static void generate_session_id(void)
{
    int written = snprintf(
        s_session_id,
        sizeof(s_session_id),
        "%s-%" PRIu64,
        CONFIG_SPINEGUARD_DEVICE_ID,
        (uint64_t)time(NULL));
    if (written < 0 || written >= (int)sizeof(s_session_id)) {
        ESP_LOGE(TAG, "Session ID generation failed");
        s_session_id[0] = '\0';
    }
}

static void time_sync_notification_cb(struct timeval *tv)
{
    (void)tv;
    ESP_LOGI(TAG, "SNTP time synchronized; Unix time is valid");
}

static void start_sntp(void)
{
    if (s_sntp_started) {
        return;
    }

    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_SPINEGUARD_SNTP_SERVER);
    config.sync_cb = time_sync_notification_cb;
    ESP_ERROR_CHECK(esp_netif_sntp_init(&config));
    s_sntp_started = true;
    ESP_LOGI(TAG, "SNTP started with server %s", CONFIG_SPINEGUARD_SNTP_SERVER);
}

static void wifi_event_handler(
    void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_data;
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_bits, WIFI_CONNECTED_BIT);
        ESP_LOGW(TAG, "Wi-Fi disconnected; reconnecting");
        esp_wifi_connect();
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_wifi_bits, WIFI_CONNECTED_BIT);
        ESP_LOGI(TAG, "Wi-Fi connected; starting SNTP");
        start_sntp();
    }
}

static void wifi_start(void)
{
    if (strlen(CONFIG_SPINEGUARD_WIFI_SSID) == 0) {
        ESP_LOGW(TAG, "Wi-Fi SSID is not configured; telemetry stays local");
        return;
    }

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(err);
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    s_wifi_bits = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    memset(&s_wifi_config, 0, sizeof(s_wifi_config));
    snprintf(
        (char *)s_wifi_config.sta.ssid,
        sizeof(s_wifi_config.sta.ssid),
        "%s",
        CONFIG_SPINEGUARD_WIFI_SSID);
    snprintf(
        (char *)s_wifi_config.sta.password,
        sizeof(s_wifi_config.sta.password),
        "%s",
        CONFIG_SPINEGUARD_WIFI_PASSWORD);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &s_wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
}

static bool wifi_connected(void)
{
    return s_wifi_bits != NULL && (xEventGroupGetBits(s_wifi_bits) & WIFI_CONNECTED_BIT) != 0;
}

static void upload_json(const char *json)
{
    if (!wifi_connected()) {
        ESP_LOGW(TAG, "Upload skipped: Wi-Fi is disconnected");
        return;
    }
    if (!unix_time_valid()) {
        ESP_LOGW(TAG, "Upload skipped: waiting for SNTP time synchronization");
        return;
    }

    esp_http_client_config_t config = {
        .url = CONFIG_SPINEGUARD_BACKEND_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ESP_LOGE(TAG, "Upload failed: unable to create HTTP client");
        return;
    }

    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Device-Token", CONFIG_SPINEGUARD_DEVICE_TOKEN);
    esp_http_client_set_post_field(client, json, strlen(json));
    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        if (status >= 200 && status <= 299) {
            ESP_LOGI(TAG, "Telemetry upload succeeded: HTTP %d", status);
        } else {
            ESP_LOGW(TAG, "Telemetry upload failed: HTTP %d", status);
        }
    } else {
        ESP_LOGW(TAG, "Telemetry upload failed: %s", esp_err_to_name(err));
    }
    esp_http_client_cleanup(client);
}

static void spineguard_task(void *arg)
{
    (void)arg;
    log_stack_watermark("task start");

    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t unit = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    adc_oneshot_chan_cfg_t channel_config = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten = ADC_ATTEN_DB_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit, &adc));
    for (size_t i = 0; i < sizeof(s_fsr) / sizeof(s_fsr[0]); i++) {
        ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, s_fsr[i].channel, &channel_config));
    }

    log_stack_watermark("before Wi-Fi init");
    wifi_start();
    log_stack_watermark("after Wi-Fi init");

    char previous_posture[16] = "unknown";
    int64_t posture_started_us = esp_timer_get_time();
    int64_t sitting_started_us = 0;
    int64_t bad_posture_started_us = 0;
    int64_t last_upload_us = 0;
    uint32_t reminder_count = 0;
    bool warning_active = false;

    while (1) {
        int raw[5];
        for (size_t i = 0; i < sizeof(s_fsr) / sizeof(s_fsr[0]); i++) {
            raw[i] = read_avg(adc, s_fsr[i].channel);
        }
        pressure_values_t pressure = {
            .left = normalize_fsr(raw[0], &s_fsr[0]),
            .right = normalize_fsr(raw[1], &s_fsr[1]),
            .front = normalize_fsr(raw[2], &s_fsr[2]),
            .back = normalize_fsr(raw[3], &s_fsr[3]),
            .center = normalize_fsr(raw[4], &s_fsr[4]),
        };
        raw_pressure_values_t raw_pressure = {
            .left = raw[0],
            .right = raw[1],
            .front = raw[2],
            .back = raw[3],
            .center = raw[4],
        };
        ESP_LOGD(TAG, "FSR raw: left=%d right=%d front=%d back=%d center=%d",
            raw[0], raw[1], raw[2], raw[3], raw[4]);

        pressure_features_t features = calculate_features(&pressure);
        const char *posture = classify_posture(&features);
        int64_t now_us = esp_timer_get_time();
        if (strcmp(posture, previous_posture) != 0) {
            posture_started_us = now_us;
            snprintf(previous_posture, sizeof(previous_posture), "%s", posture);
        }

        if (strcmp(posture, "empty") == 0) {
            sitting_started_us = 0;
            bad_posture_started_us = 0;
            warning_active = false;
        } else {
            if (sitting_started_us == 0) {
                sitting_started_us = now_us;
                reminder_count = 0;
                warning_active = false;
                bad_posture_started_us = 0;
                if (unix_time_valid()) {
                    generate_session_id();
                } else {
                    s_session_id[0] = '\0';
                }
            }
            if (posture_is_bad(posture)) {
                if (bad_posture_started_us == 0) {
                    bad_posture_started_us = now_us;
                }
                if (!warning_active &&
                    now_us - bad_posture_started_us >= (int64_t)BAD_POSTURE_WARNING_SECONDS * 1000000) {
                    warning_active = true;
                    reminder_count++;
                    ESP_LOGW(TAG, "Bad posture reminder %" PRIu32 " activated", reminder_count);
                }
            } else {
                bad_posture_started_us = 0;
                warning_active = false;
            }
        }

        if (!unix_time_valid()) {
            ESP_LOGD(TAG, "Waiting for SNTP synchronization; HTTP upload is disabled");
        } else if (s_session_id[0] == '\0') {
            generate_session_id();
        }

        if (unix_time_valid() && now_us - last_upload_us >= (int64_t)UPLOAD_INTERVAL_MS * 1000) {
            uint32_t candidate_seq = s_seq + 1;
            uint64_t posture_duration_s = (uint64_t)(now_us - posture_started_us) / 1000000;
            uint64_t sitting_duration_s = sitting_started_us == 0 ? 0 :
                (uint64_t)(now_us - sitting_started_us) / 1000000;
            int written = snprintf(
                s_json_buffer, sizeof(s_json_buffer),
                "{\"protocol_version\":2,\"device_id\":\"%s\",\"session_id\":\"%s\","
                "\"seq\":%" PRIu32 ",\"timestamp_ms\":%" PRId64 ",\"posture\":\"%s\","
                "\"confidence\":%.4f,\"pressure\":{\"left\":%d,\"right\":%d,\"front\":%d,"
                "\"back\":%d,\"center\":%d},\"raw_pressure\":{\"left\":%d,\"right\":%d,\"front\":%d,"
                "\"back\":%d,\"center\":%d},\"pressure_features\":{\"total_pressure\":%d,"
                "\"left_right_diff\":%d,\"front_back_diff\":%d,\"center_x\":%.6f,\"center_y\":%.6f,"
                "\"asymmetry_index\":%.6f},\"imu\":{\"tilt_x\":0.0,\"tilt_y\":0.0,\"shake_level\":0.0},"
                "\"posture_duration_s\":%" PRIu64 ",\"sitting_duration_s\":%" PRIu64 ","
                "\"vibration_enabled\":%s,\"warning_active\":%s,\"reminder_count\":%" PRIu32 ","
                "\"battery_level\":100,\"recognition_source\":\"rule\",\"model_version\":\"rule-v0.2\","
                "\"firmware_version\":\"0.3.0\"}",
                CONFIG_SPINEGUARD_DEVICE_ID, s_session_id, candidate_seq, unix_timestamp_ms(), posture,
                rule_confidence(posture, &features), pressure.left, pressure.right, pressure.front,
                pressure.back, pressure.center, raw_pressure.left, raw_pressure.right, raw_pressure.front,
                raw_pressure.back, raw_pressure.center, features.total_pressure, features.left_right_diff,
                features.front_back_diff, features.center_x, features.center_y, features.asymmetry_index,
                posture_duration_s, sitting_duration_s,
                SPINEGUARD_VIBRATION_JSON,
                warning_active ? "true" : "false", reminder_count);
            if (written < 0) {
                ESP_LOGE(TAG, "Telemetry JSON generation failed");
            } else if (written >= (int)sizeof(s_json_buffer)) {
                ESP_LOGE(TAG, "Telemetry JSON truncated; upload skipped");
            } else {
                s_seq = candidate_seq;
                last_upload_us = now_us;
                ESP_LOGI(TAG, "Telemetry JSON: %s", s_json_buffer);
                upload_json(s_json_buffer);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));
    }

    vTaskDelete(NULL);
}

void app_main(void)
{
    BaseType_t created = xTaskCreate(
        spineguard_task,
        "spineguard",
        SPINEGUARD_TASK_STACK_SIZE,
        NULL,
        SPINEGUARD_TASK_PRIORITY,
        NULL);

    if (created != pdPASS) {
        ESP_LOGE(TAG, "Failed to create SpineGuard task");
        abort();
    }
}
