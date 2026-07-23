#ifndef SPINEGUARD_POSTURE_MODEL_H
#define SPINEGUARD_POSTURE_MODEL_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POSTURE_MODEL_FEATURE_COUNT 38
#define POSTURE_MODEL_CLASS_COUNT 5
#define POSTURE_MODEL_VERSION "spineguard_lightgbm_fsr_tof_v2"

typedef enum {
    POSTURE_NORMAL = 0,
    POSTURE_LEFT_LEAN = 1,
    POSTURE_RIGHT_LEAN = 2,
    POSTURE_FRONT_LEAN = 3,
    POSTURE_BACK_LEAN = 4,
    POSTURE_UNKNOWN = -1,
    POSTURE_EMPTY = -2,
} posture_class_t;

posture_class_t posture_model_predict(
    const float features[POSTURE_MODEL_FEATURE_COUNT],
    float probabilities[POSTURE_MODEL_CLASS_COUNT]
);

const char *posture_model_label(posture_class_t posture);

#ifdef __cplusplus
}
#endif

#endif
