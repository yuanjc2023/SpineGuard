#include "device_commands.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "nvs.h"

#define COMMAND_NAMESPACE "commands"
#define LAST_ID_KEY "last_id"
#define LAST_TYPE_KEY "last_type"
#define LAST_STATUS_KEY "last_status"
#define LAST_ERROR_KEY "last_error"

static const char *TAG = "device_commands";
static device_command_t s_pending;
static bool s_has_pending;
static device_command_status_t s_status;
static char s_last_completed_id[DEVICE_COMMAND_ID_CAPACITY];
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

const char *device_command_type_name(device_command_type_t type)
{
    switch (type) {
        case DEVICE_COMMAND_CALIBRATE_EMPTY: return "calibrate_empty";
        case DEVICE_COMMAND_RESTART: return "restart";
        case DEVICE_COMMAND_ENTER_PROVISIONING: return "enter_provisioning";
        case DEVICE_COMMAND_FACTORY_RESET: return "factory_reset";
        case DEVICE_COMMAND_ROTATE_CLAIM_CODE: return "rotate_claim_code";
        case DEVICE_COMMAND_OTA_UPDATE: return "ota_update";
        default: return "none";
    }
}

const char *device_command_status_name(device_command_status_code_t status)
{
    switch (status) {
        case DEVICE_COMMAND_STATUS_QUEUED: return "queued";
        case DEVICE_COMMAND_STATUS_RUNNING: return "running";
        case DEVICE_COMMAND_STATUS_SUCCESS: return "success";
        case DEVICE_COMMAND_STATUS_FAILED: return "failed";
        default: return "idle";
    }
}

static device_command_type_t parse_type(const char *name)
{
    if (name == NULL) return DEVICE_COMMAND_NONE;
    if (strcmp(name, "calibrate_empty") == 0) return DEVICE_COMMAND_CALIBRATE_EMPTY;
    if (strcmp(name, "restart") == 0) return DEVICE_COMMAND_RESTART;
    if (strcmp(name, "enter_provisioning") == 0) return DEVICE_COMMAND_ENTER_PROVISIONING;
    if (strcmp(name, "factory_reset") == 0) return DEVICE_COMMAND_FACTORY_RESET;
    if (strcmp(name, "rotate_claim_code") == 0) return DEVICE_COMMAND_ROTATE_CLAIM_CODE;
    if (strcmp(name, "ota_update") == 0) return DEVICE_COMMAND_OTA_UPDATE;
    return DEVICE_COMMAND_NONE;
}

static bool valid_id(const char *id)
{
    if (id == NULL) return false;
    const size_t length = strlen(id);
    if (length == 0 || length >= DEVICE_COMMAND_ID_CAPACITY) return false;
    for (size_t i = 0; i < length; ++i) {
        const unsigned char c = (unsigned char)id[i];
        if (c < 0x21 || c > 0x7e) return false;
    }
    return true;
}

static esp_err_t persist_terminal_status(const device_command_status_t *status)
{
    nvs_handle_t nvs = 0;
    esp_err_t err = nvs_open(COMMAND_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK) err = nvs_set_str(nvs, LAST_ID_KEY, status->id);
    if (err == ESP_OK) err = nvs_set_u8(nvs, LAST_TYPE_KEY, (uint8_t)status->type);
    if (err == ESP_OK) err = nvs_set_u8(nvs, LAST_STATUS_KEY, (uint8_t)status->status);
    if (err == ESP_OK) err = nvs_set_str(nvs, LAST_ERROR_KEY, status->error);
    if (err == ESP_OK) err = nvs_commit(nvs);
    if (nvs != 0) nvs_close(nvs);
    return err;
}

esp_err_t device_commands_init(void)
{
    memset(&s_pending, 0, sizeof(s_pending));
    memset(&s_status, 0, sizeof(s_status));
    s_status.status = DEVICE_COMMAND_STATUS_IDLE;
    s_has_pending = false;

    nvs_handle_t nvs = 0;
    const esp_err_t open_err = nvs_open(COMMAND_NAMESPACE, NVS_READONLY, &nvs);
    if (open_err == ESP_OK) {
        size_t id_size = sizeof(s_last_completed_id);
        uint8_t type = 0;
        uint8_t status = 0;
        char error[DEVICE_COMMAND_ERROR_CAPACITY] = {0};
        size_t error_size = sizeof(error);
        if (nvs_get_str(nvs, LAST_ID_KEY, s_last_completed_id, &id_size) == ESP_OK) {
            nvs_get_u8(nvs, LAST_TYPE_KEY, &type);
            nvs_get_u8(nvs, LAST_STATUS_KEY, &status);
            nvs_get_str(nvs, LAST_ERROR_KEY, error, &error_size);
            snprintf(s_status.id, sizeof(s_status.id), "%s", s_last_completed_id);
            s_status.type = (device_command_type_t)type;
            s_status.status = (device_command_status_code_t)status;
            s_status.progress_percent = 100;
            snprintf(s_status.error, sizeof(s_status.error), "%s", error);
        }
        nvs_close(nvs);
    } else if (open_err != ESP_ERR_NVS_NOT_FOUND) {
        return open_err;
    }
    return ESP_OK;
}

bool device_commands_submit(
    const char *id,
    const char *type_name,
    const char *firmware_url,
    const char *firmware_sha256,
    const char *target_version
)
{
    const device_command_type_t type = parse_type(type_name);
    if (!valid_id(id) || type == DEVICE_COMMAND_NONE) return false;
    if (type == DEVICE_COMMAND_OTA_UPDATE) {
        if (firmware_url == NULL || firmware_sha256 == NULL || target_version == NULL ||
            strlen(firmware_url) == 0 || strlen(firmware_url) >= DEVICE_COMMAND_URL_CAPACITY ||
            strlen(firmware_sha256) != 64 || strlen(target_version) == 0 ||
            strlen(target_version) >= DEVICE_COMMAND_VERSION_CAPACITY) {
            return false;
        }
    }

    bool accepted = false;
    portENTER_CRITICAL(&s_lock);
    const bool duplicate = strcmp(id, s_last_completed_id) == 0 ||
        (s_has_pending && strcmp(id, s_pending.id) == 0) ||
        ((s_status.status == DEVICE_COMMAND_STATUS_RUNNING || s_status.status == DEVICE_COMMAND_STATUS_QUEUED) &&
         strcmp(id, s_status.id) == 0);
    if (!duplicate && !s_has_pending && s_status.status != DEVICE_COMMAND_STATUS_RUNNING) {
        memset(&s_pending, 0, sizeof(s_pending));
        snprintf(s_pending.id, sizeof(s_pending.id), "%s", id);
        s_pending.type = type;
        snprintf(s_pending.firmware_url, sizeof(s_pending.firmware_url), "%s", firmware_url != NULL ? firmware_url : "");
        snprintf(s_pending.firmware_sha256, sizeof(s_pending.firmware_sha256), "%s", firmware_sha256 != NULL ? firmware_sha256 : "");
        snprintf(s_pending.target_version, sizeof(s_pending.target_version), "%s", target_version != NULL ? target_version : "");
        s_has_pending = true;
        memset(&s_status, 0, sizeof(s_status));
        snprintf(s_status.id, sizeof(s_status.id), "%s", id);
        s_status.type = type;
        s_status.status = DEVICE_COMMAND_STATUS_QUEUED;
        accepted = true;
    }
    portEXIT_CRITICAL(&s_lock);

    if (accepted) ESP_LOGI(TAG, "Queued command %s (%s)", id, type_name);
    return accepted;
}

bool device_commands_take_pending(device_command_t *out)
{
    if (out == NULL) return false;
    bool available = false;
    portENTER_CRITICAL(&s_lock);
    if (s_has_pending) {
        *out = s_pending;
        s_has_pending = false;
        s_status.status = DEVICE_COMMAND_STATUS_RUNNING;
        s_status.progress_percent = 0;
        s_status.error[0] = '\0';
        available = true;
    }
    portEXIT_CRITICAL(&s_lock);
    return available;
}

void device_commands_set_progress(const char *id, uint8_t progress_percent)
{
    if (id == NULL) return;
    portENTER_CRITICAL(&s_lock);
    if (strcmp(id, s_status.id) == 0 && s_status.status == DEVICE_COMMAND_STATUS_RUNNING) {
        s_status.progress_percent = progress_percent > 100 ? 100 : progress_percent;
    }
    portEXIT_CRITICAL(&s_lock);
}

esp_err_t device_commands_complete(const char *id, bool success, const char *error)
{
    if (id == NULL || strcmp(id, s_status.id) != 0) return ESP_ERR_INVALID_ARG;
    device_command_status_t terminal;
    portENTER_CRITICAL(&s_lock);
    s_status.status = success ? DEVICE_COMMAND_STATUS_SUCCESS : DEVICE_COMMAND_STATUS_FAILED;
    s_status.progress_percent = 100;
    snprintf(s_status.error, sizeof(s_status.error), "%s", error != NULL ? error : "");
    snprintf(s_last_completed_id, sizeof(s_last_completed_id), "%s", id);
    terminal = s_status;
    portEXIT_CRITICAL(&s_lock);
    return persist_terminal_status(&terminal);
}

void device_commands_get_status(device_command_status_t *out)
{
    if (out == NULL) return;
    portENTER_CRITICAL(&s_lock);
    *out = s_status;
    portEXIT_CRITICAL(&s_lock);
}
