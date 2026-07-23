#ifndef SPINEGUARD_DEVICE_OTA_H
#define SPINEGUARD_DEVICE_OTA_H

#include "device_commands.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts a background OTA task. The command status is updated asynchronously. */
esp_err_t device_ota_start(const device_command_t *command);

#ifdef __cplusplus
}
#endif

#endif
