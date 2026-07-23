#include "device_health.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "motor_control.h"

#define ADC_LOW_THRESHOLD 5
#define ADC_HIGH_THRESHOLD 4090
#define RAIL_CONFIRM_FRAMES 20
#define NO_CHANGE_CONFIRM_FRAMES 300
#define BASELINE_DRIFT_THRESHOLD 150.0f
#define BASELINE_DRIFT_CONFIRM_FRAMES 50
#define OUT_OF_RANGE_CONFIRM_FRAMES 100

static float s_baseline[FSR_COUNT];
static int s_previous_raw[FSR_COUNT];
static bool s_previous_valid[FSR_COUNT];
static uint16_t s_low_count[FSR_COUNT];
static uint16_t s_high_count[FSR_COUNT];
static uint16_t s_same_count[FSR_COUNT];
static uint16_t s_drift_count[FSR_COUNT];
static uint16_t s_out_range_count[FSR_COUNT];
static device_health_snapshot_t s_snapshot;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

const char *fsr_health_name(fsr_health_code_t code)
{
    switch (code) {
        case FSR_HEALTH_OK: return "ok";
        case FSR_HEALTH_BASELINE_INVALID: return "baseline_invalid";
        case FSR_HEALTH_BASELINE_DRIFT: return "baseline_drift";
        case FSR_HEALTH_STUCK_LOW: return "stuck_low";
        case FSR_HEALTH_STUCK_HIGH: return "stuck_high";
        case FSR_HEALTH_NO_CHANGE: return "no_change";
        case FSR_HEALTH_OUT_OF_CALIBRATION: return "out_of_calibration";
        default: return "unknown";
    }
}

static bool baseline_is_valid_value(float value)
{
    return isfinite(value) && value >= 20.0f && value <= 4075.0f;
}

void device_health_reset_baseline(const float baseline[FSR_COUNT])
{
    memset(s_previous_raw, 0, sizeof(s_previous_raw));
    memset(s_previous_valid, 0, sizeof(s_previous_valid));
    memset(s_low_count, 0, sizeof(s_low_count));
    memset(s_high_count, 0, sizeof(s_high_count));
    memset(s_same_count, 0, sizeof(s_same_count));
    memset(s_drift_count, 0, sizeof(s_drift_count));
    memset(s_out_range_count, 0, sizeof(s_out_range_count));
    memcpy(s_baseline, baseline, sizeof(s_baseline));

    bool all_baselines_valid = true;
    device_health_snapshot_t next = {0};
    for (int i = 0; i < FSR_COUNT; ++i) {
        const bool valid = baseline_is_valid_value(s_baseline[i]);
        next.fsr[i] = valid ? FSR_HEALTH_UNKNOWN : FSR_HEALTH_BASELINE_INVALID;
        all_baselines_valid = all_baselines_valid && valid;
    }
    next.baseline_valid = all_baselines_valid;
    next.motor_control_ready = motor_control_is_ready();
    next.motor_self_test_completed = motor_control_self_test_completed();
    next.motor_power_verified = false;
    portENTER_CRITICAL(&s_lock);
    s_snapshot = next;
    portEXIT_CRITICAL(&s_lock);
}

void device_health_init(const float baseline[FSR_COUNT])
{
    device_health_reset_baseline(baseline);
}

static uint16_t increment_saturated(uint16_t value)
{
    return value == UINT16_MAX ? value : (uint16_t)(value + 1);
}

void device_health_update(const fsr_frame_t *frame, const vl53l1x_sample_t *tof)
{
    if (frame == NULL || tof == NULL) return;
    device_health_snapshot_t next = {0};
    next.baseline_valid = true;
    next.fsr_all_ok = true;

    for (int i = 0; i < FSR_COUNT; ++i) {
        const int raw = frame->raw_adc[i];
        s_low_count[i] = raw <= ADC_LOW_THRESHOLD ? increment_saturated(s_low_count[i]) : 0;
        s_high_count[i] = raw >= ADC_HIGH_THRESHOLD ? increment_saturated(s_high_count[i]) : 0;
        if (s_previous_valid[i] && raw == s_previous_raw[i]) {
            s_same_count[i] = increment_saturated(s_same_count[i]);
        } else {
            s_same_count[i] = 0;
        }
        s_previous_raw[i] = raw;
        s_previous_valid[i] = true;

        const bool baseline_valid = baseline_is_valid_value(s_baseline[i]);
        next.baseline_valid = next.baseline_valid && baseline_valid;
        const bool drift = !frame->occupied && fabsf(frame->filtered_adc[i] - s_baseline[i]) > BASELINE_DRIFT_THRESHOLD;
        s_drift_count[i] = drift ? increment_saturated(s_drift_count[i]) : 0;
        const bool out_of_range = frame->active[i] && !frame->within_calibration_range[i];
        s_out_range_count[i] = out_of_range ? increment_saturated(s_out_range_count[i]) : 0;

        fsr_health_code_t code = FSR_HEALTH_OK;
        if (!baseline_valid) code = FSR_HEALTH_BASELINE_INVALID;
        else if (s_low_count[i] >= RAIL_CONFIRM_FRAMES) code = FSR_HEALTH_STUCK_LOW;
        else if (s_high_count[i] >= RAIL_CONFIRM_FRAMES) code = FSR_HEALTH_STUCK_HIGH;
        else if (s_drift_count[i] >= BASELINE_DRIFT_CONFIRM_FRAMES) code = FSR_HEALTH_BASELINE_DRIFT;
        else if (s_same_count[i] >= NO_CHANGE_CONFIRM_FRAMES) code = FSR_HEALTH_NO_CHANGE;
        else if (s_out_range_count[i] >= OUT_OF_RANGE_CONFIRM_FRAMES) code = FSR_HEALTH_OUT_OF_CALIBRATION;
        next.fsr[i] = code;
        next.fsr_all_ok = next.fsr_all_ok && code == FSR_HEALTH_OK;
    }

    next.tof_online = tof->online;
    next.tof_valid = tof->online && tof->valid && tof->range_status == 0;
    next.motor_control_ready = motor_control_is_ready();
    next.motor_self_test_completed = motor_control_self_test_completed();
    next.motor_power_verified = false;

    portENTER_CRITICAL(&s_lock);
    s_snapshot = next;
    portEXIT_CRITICAL(&s_lock);
}

void device_health_get_snapshot(device_health_snapshot_t *out)
{
    if (out == NULL) return;
    portENTER_CRITICAL(&s_lock);
    *out = s_snapshot;
    portEXIT_CRITICAL(&s_lock);
}
