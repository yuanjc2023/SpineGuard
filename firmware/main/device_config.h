#ifndef SPINEGUARD_DEVICE_CONFIG_H
#define SPINEGUARD_DEVICE_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    REMINDER_MODE_NORMAL = 0,
    REMINDER_MODE_STUDY,
    REMINDER_MODE_DO_NOT_DISTURB,
} reminder_mode_t;

typedef struct {
    uint32_t applied_config_version;
    bool vibration_enabled;
    reminder_mode_t mode;
    uint32_t trigger_duration_s;
    uint32_t vibration_duration_s;
    uint32_t cooldown_s;
    uint8_t intensity_percent;
} device_runtime_config_t;

esp_err_t device_config_init(void);
esp_err_t device_config_start_polling(void);
void device_config_get(device_runtime_config_t *out);
bool device_config_effective_vibration_enabled(const device_runtime_config_t *config);
const char *reminder_mode_name(reminder_mode_t mode);

#ifdef __cplusplus
}
#endif

#endif
