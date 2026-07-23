#ifndef SPINEGUARD_MOTOR_CONTROL_H
#define SPINEGUARD_MOTOR_CONTROL_H

#include <stdbool.h>
#include <stdint.h>

#include "posture_model.h"

#ifdef __cplusplus
extern "C" {
#endif

void motor_control_init(bool enabled, uint8_t intensity_percent);
void motor_control_set_enabled(bool enabled);
void motor_control_set_intensity(uint8_t intensity_percent);
bool motor_control_is_enabled(void);
bool motor_control_is_active(void);
bool motor_control_is_ready(void);
bool motor_control_self_test_completed(void);
uint8_t motor_control_intensity_percent(void);
const char *motor_control_active_position(void);

bool motor_control_start_for_posture(
    posture_class_t posture,
    uint32_t duration_ms,
    int64_t now_ms
);

void motor_control_stop(void);
void motor_control_update(int64_t now_ms);
void motor_control_self_test(void);

#ifdef __cplusplus
}
#endif

#endif
