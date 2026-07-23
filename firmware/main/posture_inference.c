#include "posture_inference.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#define WINDOW_FRAMES 20
#define STEP_FRAMES 10
#define WARMUP_MS 5000
#define MAX_GAP_MS 250
#define EXPECTED_WINDOW_MS 1900
#define WINDOW_TOLERANCE_MS 500
#define TOF_MIN_MM 40.0f
#define TOF_MAX_MM 2000.0f
#define ASYMMETRY_EPSILON 1.0e-9f

typedef struct {
    int64_t time_ms;
    float ratio[FSR_COUNT];
    float total_calibrated_g;
    float backrest_distance_mm;
} inference_frame_t;

static inference_frame_t s_window[WINDOW_FRAMES];
static int s_frame_count;
static int s_frames_since_prediction;
static int64_t s_occupied_since_ms;
static bool s_occupied_tracking;
static int64_t s_last_valid_ms;
static uint32_t s_inference_id;

static bool frame_is_valid(const fsr_frame_t *fsr, const vl53l1x_sample_t *tof)
{
    if (!fsr->occupied || !fsr->ratio_valid || fsr->total_calibrated_g <= 0.0f) {
        return false;
    }
    if (
        !tof->online ||
        !tof->data_ready ||
        !tof->valid ||
        tof->range_status != 0
    ) {
        return false;
    }
    if (
        !isfinite(tof->distance_filtered_mm) ||
        tof->distance_filtered_mm < TOF_MIN_MM ||
        tof->distance_filtered_mm > TOF_MAX_MM
    ) {
        return false;
    }

    float ratio_sum = 0.0f;
    for (int i = 0; i < FSR_COUNT; ++i) {
        const float ratio = fsr->calibrated_ratio[i];
        if (!isfinite(ratio) || ratio < -1.0e-6f || ratio > 1.000001f) {
            return false;
        }
        ratio_sum += ratio;
    }
    return ratio_sum >= 0.95f && ratio_sum <= 1.05f;
}

static void reset_window_only(void)
{
    memset(s_window, 0, sizeof(s_window));
    s_frame_count = 0;
    s_frames_since_prediction = 0;
    s_last_valid_ms = 0;
}

void posture_inference_init(void)
{
    posture_inference_reset();
}

void posture_inference_reset(void)
{
    reset_window_only();
    s_occupied_since_ms = 0;
    s_occupied_tracking = false;
    s_inference_id = 0;
}

static void append_frame(const fsr_frame_t *fsr, const vl53l1x_sample_t *tof)
{
    if (s_frame_count < WINDOW_FRAMES) {
        s_frame_count++;
    } else {
        memmove(
            &s_window[0],
            &s_window[1],
            sizeof(s_window[0]) * (WINDOW_FRAMES - 1)
        );
    }

    inference_frame_t *dst = &s_window[s_frame_count - 1];
    dst->time_ms = fsr->device_time_ms;
    memcpy(dst->ratio, fsr->calibrated_ratio, sizeof(dst->ratio));
    dst->total_calibrated_g = fsr->total_calibrated_g;
    dst->backrest_distance_mm = tof->distance_filtered_mm;
    s_frames_since_prediction++;
}

static float mean_of(const float values[WINDOW_FRAMES])
{
    float sum = 0.0f;
    for (int i = 0; i < WINDOW_FRAMES; ++i) {
        sum += values[i];
    }
    return sum / (float)WINDOW_FRAMES;
}

static float std_of(const float values[WINDOW_FRAMES], float mean)
{
    float sum = 0.0f;
    for (int i = 0; i < WINDOW_FRAMES; ++i) {
        const float delta = values[i] - mean;
        sum += delta * delta;
    }
    return sqrtf(sum / (float)WINDOW_FRAMES);
}

static float min_of(const float values[WINDOW_FRAMES])
{
    float result = values[0];
    for (int i = 1; i < WINDOW_FRAMES; ++i) {
        if (values[i] < result) {
            result = values[i];
        }
    }
    return result;
}

static float max_of(const float values[WINDOW_FRAMES])
{
    float result = values[0];
    for (int i = 1; i < WINDOW_FRAMES; ++i) {
        if (values[i] > result) {
            result = values[i];
        }
    }
    return result;
}

static float slope_of(const float values[WINDOW_FRAMES])
{
    float times_s[WINDOW_FRAMES];
    float mean_t = 0.0f;
    float mean_v = 0.0f;
    const int64_t start_ms = s_window[0].time_ms;

    for (int i = 0; i < WINDOW_FRAMES; ++i) {
        times_s[i] = (float)(s_window[i].time_ms - start_ms) / 1000.0f;
        mean_t += times_s[i];
        mean_v += values[i];
    }
    mean_t /= (float)WINDOW_FRAMES;
    mean_v /= (float)WINDOW_FRAMES;

    float numerator = 0.0f;
    float denominator = 0.0f;
    for (int i = 0; i < WINDOW_FRAMES; ++i) {
        const float centered_t = times_s[i] - mean_t;
        numerator += centered_t * (values[i] - mean_v);
        denominator += centered_t * centered_t;
    }
    return denominator <= 1.0e-12f ? 0.0f : numerator / denominator;
}

static void write_stats(
    const float values[WINDOW_FRAMES],
    bool include_slope,
    float *features,
    int *index
)
{
    const float mean = mean_of(values);
    features[(*index)++] = mean;
    features[(*index)++] = std_of(values, mean);
    features[(*index)++] = min_of(values);
    features[(*index)++] = max_of(values);
    if (include_slope) {
        features[(*index)++] = slope_of(values);
    }
}

static bool build_features(float features[POSTURE_MODEL_FEATURE_COUNT])
{
    const int64_t span_ms = s_window[WINDOW_FRAMES - 1].time_ms - s_window[0].time_ms;
    if (llabs(span_ms - EXPECTED_WINDOW_MS) > WINDOW_TOLERANCE_MS) {
        return false;
    }

    int index = 0;
    float values[WINDOW_FRAMES];

    /* 25 FSR ratio features: mean/std/min/max/slope for each sensor. */
    for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
        for (int frame = 0; frame < WINDOW_FRAMES; ++frame) {
            values[frame] = s_window[frame].ratio[sensor];
        }
        write_stats(values, true, features, &index);
    }

    /* Left/right asymmetry mean and std. */
    for (int frame = 0; frame < WINDOW_FRAMES; ++frame) {
        const float left = s_window[frame].ratio[FSR_LEFT];
        const float right = s_window[frame].ratio[FSR_RIGHT];
        values[frame] = (left - right) / (left + right + ASYMMETRY_EPSILON);
    }
    const float lr_mean = mean_of(values);
    features[index++] = lr_mean;
    features[index++] = std_of(values, lr_mean);

    /* Front/back asymmetry mean and std. */
    for (int frame = 0; frame < WINDOW_FRAMES; ++frame) {
        const float front = s_window[frame].ratio[FSR_FRONT];
        const float back = s_window[frame].ratio[FSR_BACK];
        values[frame] = (front - back) / (front + back + ASYMMETRY_EPSILON);
    }
    const float fb_mean = mean_of(values);
    features[index++] = fb_mean;
    features[index++] = std_of(values, fb_mean);

    /* Total calibrated load mean/std/min/max. */
    for (int frame = 0; frame < WINDOW_FRAMES; ++frame) {
        values[frame] = s_window[frame].total_calibrated_g;
    }
    write_stats(values, false, features, &index);

    /* ToF distance mean/std/min/max/slope. */
    for (int frame = 0; frame < WINDOW_FRAMES; ++frame) {
        values[frame] = s_window[frame].backrest_distance_mm;
    }
    write_stats(values, true, features, &index);

    return index == POSTURE_MODEL_FEATURE_COUNT;
}

bool posture_inference_push(
    const fsr_frame_t *fsr,
    const vl53l1x_sample_t *tof,
    posture_inference_result_t *result
)
{
    memset(result, 0, sizeof(*result));
    result->posture = fsr->occupied ? POSTURE_UNKNOWN : POSTURE_EMPTY;

    if (!fsr->occupied) {
        s_occupied_since_ms = 0;
        s_occupied_tracking = false;
        reset_window_only();
        return false;
    }

    if (!s_occupied_tracking) {
        s_occupied_since_ms = fsr->device_time_ms;
        s_occupied_tracking = true;
        reset_window_only();
    }

    if (fsr->device_time_ms - s_occupied_since_ms < WARMUP_MS) {
        return false;
    }

    if (!frame_is_valid(fsr, tof)) {
        if (
            s_last_valid_ms != 0 &&
            fsr->device_time_ms - s_last_valid_ms > MAX_GAP_MS
        ) {
            reset_window_only();
        }
        return false;
    }

    if (
        s_last_valid_ms != 0 &&
        fsr->device_time_ms - s_last_valid_ms > MAX_GAP_MS
    ) {
        reset_window_only();
    }
    s_last_valid_ms = fsr->device_time_ms;
    append_frame(fsr, tof);

    if (s_frame_count < WINDOW_FRAMES) {
        return false;
    }
    if (s_inference_id > 0 && s_frames_since_prediction < STEP_FRAMES) {
        return false;
    }

    float features[POSTURE_MODEL_FEATURE_COUNT];
    if (!build_features(features)) {
        reset_window_only();
        return false;
    }

    result->posture = posture_model_predict(features, result->probabilities);
    result->confidence = result->posture >= 0
        ? result->probabilities[(int)result->posture]
        : 0.0f;
    result->ready = result->posture >= 0;
    result->inference_id = ++s_inference_id;
    result->window_start_ms = s_window[0].time_ms;
    result->window_end_ms = s_window[WINDOW_FRAMES - 1].time_ms;
    s_frames_since_prediction = 0;
    return result->ready;
}
