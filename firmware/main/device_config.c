#include "device_config.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "device_commands.h"
#include "device_identity.h"
#include "esp_check.h"
#include "esp_http_client.h"
#include "esp_log.h"
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#include "esp_crt_bundle.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "motor_control.h"
#include "nvs.h"
#include "sdkconfig.h"
#include "wifi_manager.h"

#define CONFIG_NAMESPACE "device_cfg"
#define KEY_VERSION "cfg_ver"
#define KEY_ENABLED "vib_en"
#define KEY_MODE "mode"
#define KEY_TRIGGER "trig_s"
#define KEY_DURATION "vib_s"
#define KEY_COOLDOWN "cool_s"
#define KEY_INTENSITY "intensity"
#define CONFIG_TASK_STACK_SIZE 7168
#define CONFIG_TASK_PRIORITY 3
#define RESPONSE_BUFFER_SIZE 2048

static const char *TAG = "device_config";
static device_runtime_config_t s_config;
static char s_response[RESPONSE_BUFFER_SIZE];
static size_t s_response_length;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

const char *reminder_mode_name(reminder_mode_t mode)
{
    switch (mode) {
        case REMINDER_MODE_STUDY: return "study";
        case REMINDER_MODE_DO_NOT_DISTURB: return "do_not_disturb";
        default: return "normal";
    }
}

static bool parse_mode(const char *name, reminder_mode_t *mode)
{
    if (name == NULL || mode == NULL) return false;
    if (strcmp(name, "normal") == 0) *mode = REMINDER_MODE_NORMAL;
    else if (strcmp(name, "study") == 0) *mode = REMINDER_MODE_STUDY;
    else if (strcmp(name, "do_not_disturb") == 0) *mode = REMINDER_MODE_DO_NOT_DISTURB;
    else return false;
    return true;
}

static device_runtime_config_t default_config(void)
{
    return (device_runtime_config_t) {
        .applied_config_version = 0,
        .vibration_enabled = CONFIG_SPINEGUARD_VIBRATION_DEFAULT_ENABLED,
        .mode = REMINDER_MODE_NORMAL,
        .trigger_duration_s = CONFIG_SPINEGUARD_REMINDER_TRIGGER_DEFAULT_S,
        .vibration_duration_s = CONFIG_SPINEGUARD_REMINDER_DURATION_DEFAULT_S,
        .cooldown_s = CONFIG_SPINEGUARD_REMINDER_COOLDOWN_DEFAULT_S,
        .intensity_percent = CONFIG_SPINEGUARD_REMINDER_INTENSITY_DEFAULT_PERCENT,
    };
}

static void apply_mode_defaults(device_runtime_config_t *config, reminder_mode_t mode)
{
    config->mode = mode;
    if (mode == REMINDER_MODE_NORMAL) {
        config->trigger_duration_s = 300;
        config->vibration_duration_s = 30;
        config->cooldown_s = 600;
        config->intensity_percent = 70;
    } else if (mode == REMINDER_MODE_STUDY) {
        config->trigger_duration_s = 600;
        config->vibration_duration_s = 10;
        config->cooldown_s = 900;
        config->intensity_percent = 40;
    }
}

static bool config_valid(const device_runtime_config_t *config)
{
    return config != NULL &&
        config->mode >= REMINDER_MODE_NORMAL && config->mode <= REMINDER_MODE_DO_NOT_DISTURB &&
        config->trigger_duration_s >= 5 && config->trigger_duration_s <= 3600 &&
        config->vibration_duration_s >= 1 && config->vibration_duration_s <= 120 &&
        config->cooldown_s >= 30 && config->cooldown_s <= 7200 &&
        config->intensity_percent >= 1 && config->intensity_percent <= 100;
}

static esp_err_t save_config(const device_runtime_config_t *config)
{
    nvs_handle_t nvs = 0;
    esp_err_t err = nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK) err = nvs_set_u32(nvs, KEY_VERSION, config->applied_config_version);
    if (err == ESP_OK) err = nvs_set_u8(nvs, KEY_ENABLED, config->vibration_enabled ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_u8(nvs, KEY_MODE, (uint8_t)config->mode);
    if (err == ESP_OK) err = nvs_set_u32(nvs, KEY_TRIGGER, config->trigger_duration_s);
    if (err == ESP_OK) err = nvs_set_u32(nvs, KEY_DURATION, config->vibration_duration_s);
    if (err == ESP_OK) err = nvs_set_u32(nvs, KEY_COOLDOWN, config->cooldown_s);
    if (err == ESP_OK) err = nvs_set_u8(nvs, KEY_INTENSITY, config->intensity_percent);
    if (err == ESP_OK) err = nvs_commit(nvs);
    if (nvs != 0) nvs_close(nvs);
    return err;
}

static void publish_config(const device_runtime_config_t *config)
{
    portENTER_CRITICAL(&s_lock);
    s_config = *config;
    portEXIT_CRITICAL(&s_lock);
    motor_control_set_intensity(config->intensity_percent);
    motor_control_set_enabled(device_config_effective_vibration_enabled(config));
}

esp_err_t device_config_init(void)
{
    device_runtime_config_t loaded = default_config();
    nvs_handle_t nvs = 0;
    const esp_err_t open_err = nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &nvs);
    if (open_err == ESP_OK) {
        uint8_t value8 = 0;
        nvs_get_u32(nvs, KEY_VERSION, &loaded.applied_config_version);
        if (nvs_get_u8(nvs, KEY_ENABLED, &value8) == ESP_OK) loaded.vibration_enabled = value8 != 0;
        if (nvs_get_u8(nvs, KEY_MODE, &value8) == ESP_OK) loaded.mode = (reminder_mode_t)value8;
        nvs_get_u32(nvs, KEY_TRIGGER, &loaded.trigger_duration_s);
        nvs_get_u32(nvs, KEY_DURATION, &loaded.vibration_duration_s);
        nvs_get_u32(nvs, KEY_COOLDOWN, &loaded.cooldown_s);
        if (nvs_get_u8(nvs, KEY_INTENSITY, &value8) == ESP_OK) loaded.intensity_percent = value8;
        nvs_close(nvs);
    } else if (open_err != ESP_ERR_NVS_NOT_FOUND) {
        return open_err;
    }
    if (!config_valid(&loaded)) loaded = default_config();
    portENTER_CRITICAL(&s_lock);
    s_config = loaded;
    portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG, "Loaded config v%lu mode=%s enabled=%d trigger=%lus duration=%lus cooldown=%lus intensity=%u%%",
        (unsigned long)loaded.applied_config_version, reminder_mode_name(loaded.mode), loaded.vibration_enabled,
        (unsigned long)loaded.trigger_duration_s, (unsigned long)loaded.vibration_duration_s,
        (unsigned long)loaded.cooldown_s, loaded.intensity_percent);
    return ESP_OK;
}

void device_config_get(device_runtime_config_t *out)
{
    if (out == NULL) return;
    portENTER_CRITICAL(&s_lock);
    *out = s_config;
    portEXIT_CRITICAL(&s_lock);
}

bool device_config_effective_vibration_enabled(const device_runtime_config_t *config)
{
    return config != NULL && config->vibration_enabled && config->mode != REMINDER_MODE_DO_NOT_DISTURB;
}

static esp_err_t http_event_handler(esp_http_client_event_t *event)
{
    if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
        const size_t remaining = sizeof(s_response) - 1 - s_response_length;
        const size_t copy_length = (size_t)event->data_len < remaining ? (size_t)event->data_len : remaining;
        memcpy(s_response + s_response_length, event->data, copy_length);
        s_response_length += copy_length;
        s_response[s_response_length] = '\0';
    }
    return ESP_OK;
}

static cJSON *field(cJSON *root, cJSON *data, const char *name)
{
    cJSON *value = cJSON_GetObjectItemCaseSensitive(root, name);
    if (value == NULL && cJSON_IsObject(data)) value = cJSON_GetObjectItemCaseSensitive(data, name);
    return value;
}

static uint32_t number_u32(cJSON *value, uint32_t fallback)
{
    if (!cJSON_IsNumber(value) || value->valuedouble < 0 || value->valuedouble > UINT32_MAX) return fallback;
    return (uint32_t)value->valuedouble;
}

static uint8_t number_u8(cJSON *value, uint8_t fallback)
{
    if (!cJSON_IsNumber(value) || value->valuedouble < 0 || value->valuedouble > UINT8_MAX) return fallback;
    return (uint8_t)value->valuedouble;
}

static void apply_command(cJSON *root, cJSON *data)
{
    cJSON *command = field(root, data, "command");
    if (!cJSON_IsObject(command)) return;
    cJSON *id = cJSON_GetObjectItemCaseSensitive(command, "id");
    cJSON *type = cJSON_GetObjectItemCaseSensitive(command, "type");
    cJSON *firmware_url = cJSON_GetObjectItemCaseSensitive(command, "firmware_url");
    cJSON *firmware_sha256 = cJSON_GetObjectItemCaseSensitive(command, "firmware_sha256");
    cJSON *target_version = cJSON_GetObjectItemCaseSensitive(command, "target_version");
    if (cJSON_IsString(id) && cJSON_IsString(type)) {
        device_commands_submit(
            id->valuestring,
            type->valuestring,
            cJSON_IsString(firmware_url) ? firmware_url->valuestring : NULL,
            cJSON_IsString(firmware_sha256) ? firmware_sha256->valuestring : NULL,
            cJSON_IsString(target_version) ? target_version->valuestring : NULL
        );
    }
}

static void apply_response(void)
{
    cJSON *root = cJSON_Parse(s_response);
    if (root == NULL) {
        ESP_LOGW(TAG, "Invalid device configuration JSON");
        return;
    }
    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    apply_command(root, data);

    device_runtime_config_t current;
    device_config_get(&current);
    device_runtime_config_t next = current;

    cJSON *version_json = field(root, data, "config_version");
    const bool version_present = cJSON_IsNumber(version_json) && version_json->valuedouble >= 0;
    const uint32_t incoming_version = number_u32(version_json, current.applied_config_version);
    const bool should_apply = !version_present || incoming_version > current.applied_config_version;

    if (should_apply) {
        cJSON *name = field(root, data, "device_name");
        if (cJSON_IsString(name) && device_identity_name_is_valid(name->valuestring)) {
            char current_name[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
            device_identity_copy_name(current_name, sizeof(current_name));
            if (strcmp(current_name, name->valuestring) != 0) {
                ESP_ERROR_CHECK_WITHOUT_ABORT(device_identity_set_name(name->valuestring));
            }
        }

        cJSON *reminder = field(root, data, "reminder");
        if (!cJSON_IsObject(reminder)) reminder = data;
        if (!cJSON_IsObject(reminder)) reminder = root;

        cJSON *mode_json = cJSON_GetObjectItemCaseSensitive(reminder, "mode");
        reminder_mode_t parsed_mode;
        if (cJSON_IsString(mode_json) && parse_mode(mode_json->valuestring, &parsed_mode)) {
            apply_mode_defaults(&next, parsed_mode);
        }

        cJSON *enabled = cJSON_GetObjectItemCaseSensitive(reminder, "enabled");
        if (!cJSON_IsBool(enabled)) enabled = field(root, data, "vibration_enabled");
        if (cJSON_IsBool(enabled)) next.vibration_enabled = cJSON_IsTrue(enabled);

        next.trigger_duration_s = number_u32(cJSON_GetObjectItemCaseSensitive(reminder, "trigger_duration_s"), next.trigger_duration_s);
        next.vibration_duration_s = number_u32(cJSON_GetObjectItemCaseSensitive(reminder, "vibration_duration_s"), next.vibration_duration_s);
        next.cooldown_s = number_u32(cJSON_GetObjectItemCaseSensitive(reminder, "cooldown_s"), next.cooldown_s);
        next.intensity_percent = number_u8(cJSON_GetObjectItemCaseSensitive(reminder, "intensity_percent"), next.intensity_percent);
        if (next.intensity_percent > CONFIG_SPINEGUARD_VIBRATION_MAX_PERCENT) {
            next.intensity_percent = CONFIG_SPINEGUARD_VIBRATION_MAX_PERCENT;
        }
        if (version_present) next.applied_config_version = incoming_version;

        if (config_valid(&next)) {
            if (memcmp(&next, &current, sizeof(next)) != 0) {
                const esp_err_t save_err = save_config(&next);
                if (save_err == ESP_OK) {
                    publish_config(&next);
                    ESP_LOGI(TAG, "Applied config v%lu mode=%s", (unsigned long)next.applied_config_version, reminder_mode_name(next.mode));
                } else {
                    ESP_LOGW(TAG, "Unable to persist config: %s", esp_err_to_name(save_err));
                }
            }
        } else {
            ESP_LOGW(TAG, "Rejected invalid reminder configuration");
        }
    }
    cJSON_Delete(root);
}

static void poll_once(void)
{
    if (!wifi_manager_is_connected()) return;
    char url[320];
    const int written = snprintf(url, sizeof(url), "%s/device/config/%s", wifi_manager_backend_base_url(), device_identity_id());
    if (written < 0 || written >= (int)sizeof(url)) {
        ESP_LOGE(TAG, "Device configuration URL is too long");
        return;
    }

    memset(s_response, 0, sizeof(s_response));
    s_response_length = 0;
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 4000,
        .event_handler = http_event_handler,
    };
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
    config.crt_bundle_attach = esp_crt_bundle_attach;
#endif
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) return;
    char secret[SPINEGUARD_DEVICE_SECRET_CAPACITY] = {0};
    device_identity_copy_secret(secret, sizeof(secret));
    esp_http_client_set_header(client, "X-Device-ID", device_identity_id());
    esp_http_client_set_header(client, "X-Device-Token", secret);

    const esp_err_t err = esp_http_client_perform(client);
    const int status = err == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    if (err == ESP_OK && status >= 200 && status < 300) apply_response();
    else ESP_LOGD(TAG, "Configuration poll failed: err=%s HTTP %d", esp_err_to_name(err), status);
    esp_http_client_cleanup(client);
}

static void config_task(void *arg)
{
    (void)arg;
    while (true) {
        poll_once();
        vTaskDelay(pdMS_TO_TICKS(CONFIG_SPINEGUARD_DEVICE_CONFIG_POLL_INTERVAL_MS));
    }
}

esp_err_t device_config_start_polling(void)
{
    const BaseType_t created = xTaskCreate(config_task, "device_config", CONFIG_TASK_STACK_SIZE, NULL, CONFIG_TASK_PRIORITY, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
