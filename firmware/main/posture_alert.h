#ifndef SPINEGUARD_POSTURE_ALERT_H
#define SPINEGUARD_POSTURE_ALERT_H

#include <stdbool.h>
#include <stdint.h>

#include "device_config.h"
#include "posture_model.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    posture_class_t stable_posture;
    uint64_t stable_duration_s;
    bool warning_active;
    bool reminder_due;
    bool reminder_suppressed;
    bool vibration_active;
    uint32_t cooldown_remaining_s;
    uint32_t reminder_count;
} posture_alert_status_t;

void posture_alert_init(void);
void posture_alert_update(
    bool inference_valid,
    posture_class_t predicted_posture,
    float confidence,
    int64_t now_ms,
    const device_runtime_config_t *config,
    posture_alert_status_t *status
);

#ifdef __cplusplus
}
#endif

#endif
