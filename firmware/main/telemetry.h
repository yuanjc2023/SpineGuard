#ifndef SPINEGUARD_TELEMETRY_H
#define SPINEGUARD_TELEMETRY_H

#include "esp_err.h"
#include "fsr_pipeline.h"
#include "posture_alert.h"
#include "vl53l1x_driver.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts the independent 2 s HTTP telemetry task. */
esp_err_t telemetry_start(void);

/*
 * Copies the latest 10 Hz sensor/state snapshot. This function is non-blocking
 * with respect to HTTP; network requests run in a separate FreeRTOS task.
 */
void telemetry_update_snapshot(
    const fsr_frame_t *fsr,
    const vl53l1x_sample_t *tof,
    posture_class_t stable_posture,
    float stable_confidence,
    const posture_alert_status_t *alert
);

#ifdef __cplusplus
}
#endif

#endif
