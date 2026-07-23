#ifndef SPINEGUARD_DEVICE_HEALTH_H
#define SPINEGUARD_DEVICE_HEALTH_H

#include <stdbool.h>

#include "fsr_pipeline.h"
#include "vl53l1x_driver.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    FSR_HEALTH_UNKNOWN = 0,
    FSR_HEALTH_OK,
    FSR_HEALTH_BASELINE_INVALID,
    FSR_HEALTH_BASELINE_DRIFT,
    FSR_HEALTH_STUCK_LOW,
    FSR_HEALTH_STUCK_HIGH,
    FSR_HEALTH_NO_CHANGE,
    FSR_HEALTH_OUT_OF_CALIBRATION,
} fsr_health_code_t;

typedef struct {
    fsr_health_code_t fsr[FSR_COUNT];
    bool fsr_all_ok;
    bool baseline_valid;
    bool tof_online;
    bool tof_valid;
    bool motor_control_ready;
    bool motor_self_test_completed;
    bool motor_power_verified;
} device_health_snapshot_t;

void device_health_init(const float baseline[FSR_COUNT]);
void device_health_reset_baseline(const float baseline[FSR_COUNT]);
void device_health_update(const fsr_frame_t *frame, const vl53l1x_sample_t *tof);
void device_health_get_snapshot(device_health_snapshot_t *out);
const char *fsr_health_name(fsr_health_code_t code);

#ifdef __cplusplus
}
#endif

#endif
