#ifndef SPINEGUARD_DEVICE_COMMANDS_H
#define SPINEGUARD_DEVICE_COMMANDS_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DEVICE_COMMAND_ID_CAPACITY 64
#define DEVICE_COMMAND_ERROR_CAPACITY 64
#define DEVICE_COMMAND_URL_CAPACITY 320
#define DEVICE_COMMAND_SHA256_CAPACITY 65
#define DEVICE_COMMAND_VERSION_CAPACITY 48

typedef enum {
    DEVICE_COMMAND_NONE = 0,
    DEVICE_COMMAND_CALIBRATE_EMPTY,
    DEVICE_COMMAND_RESTART,
    DEVICE_COMMAND_ENTER_PROVISIONING,
    DEVICE_COMMAND_FACTORY_RESET,
    DEVICE_COMMAND_ROTATE_CLAIM_CODE,
    DEVICE_COMMAND_OTA_UPDATE,
} device_command_type_t;

typedef enum {
    DEVICE_COMMAND_STATUS_IDLE = 0,
    DEVICE_COMMAND_STATUS_QUEUED,
    DEVICE_COMMAND_STATUS_RUNNING,
    DEVICE_COMMAND_STATUS_SUCCESS,
    DEVICE_COMMAND_STATUS_FAILED,
} device_command_status_code_t;

typedef struct {
    char id[DEVICE_COMMAND_ID_CAPACITY];
    device_command_type_t type;
    char firmware_url[DEVICE_COMMAND_URL_CAPACITY];
    char firmware_sha256[DEVICE_COMMAND_SHA256_CAPACITY];
    char target_version[DEVICE_COMMAND_VERSION_CAPACITY];
} device_command_t;

typedef struct {
    char id[DEVICE_COMMAND_ID_CAPACITY];
    device_command_type_t type;
    device_command_status_code_t status;
    uint8_t progress_percent;
    char error[DEVICE_COMMAND_ERROR_CAPACITY];
} device_command_status_t;

esp_err_t device_commands_init(void);
bool device_commands_submit(
    const char *id,
    const char *type_name,
    const char *firmware_url,
    const char *firmware_sha256,
    const char *target_version
);
bool device_commands_take_pending(device_command_t *out);
void device_commands_set_progress(const char *id, uint8_t progress_percent);
esp_err_t device_commands_complete(const char *id, bool success, const char *error);
void device_commands_get_status(device_command_status_t *out);
const char *device_command_type_name(device_command_type_t type);
const char *device_command_status_name(device_command_status_code_t status);

#ifdef __cplusplus
}
#endif

#endif
