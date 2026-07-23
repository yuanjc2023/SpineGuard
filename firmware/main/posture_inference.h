#ifndef SPINEGUARD_POSTURE_INFERENCE_H
#define SPINEGUARD_POSTURE_INFERENCE_H

#include <stdbool.h>
#include <stdint.h>

#include "fsr_pipeline.h"
#include "posture_model.h"
#include "vl53l1x_driver.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool ready;
    posture_class_t posture;
    float confidence;
    float probabilities[POSTURE_MODEL_CLASS_COUNT];
    uint32_t inference_id;
    int64_t window_start_ms;
    int64_t window_end_ms;
} posture_inference_result_t;

void posture_inference_init(void);
void posture_inference_reset(void);

/*
 * Push one 10 Hz FSR+ToF frame. Returns true only when a new 2 s inference
 * window has been evaluated (first at 20 valid frames, then every 10 frames).
 */
bool posture_inference_push(
    const fsr_frame_t *fsr,
    const vl53l1x_sample_t *tof,
    posture_inference_result_t *result
);

#ifdef __cplusplus
}
#endif

#endif
