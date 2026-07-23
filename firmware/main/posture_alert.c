#include "posture_alert.h"

#include <string.h>

#include "motor_control.h"

#define INVALID_GRACE_MS 3000LL
#define TRANSITION_CONFIRMATIONS 3
#define MIN_CONFIDENCE 0.50f

static posture_class_t s_stable = POSTURE_UNKNOWN;
static posture_class_t s_candidate = POSTURE_UNKNOWN;
static int s_candidate_count;
static int64_t s_stable_since_ms;
static int64_t s_last_valid_ms;
static int64_t s_next_reminder_ms;
static int64_t s_last_reminder_ms;
static bool s_has_reminded_for_episode;
static uint32_t s_reminder_count;

static bool posture_is_bad(posture_class_t posture)
{
    return posture == POSTURE_LEFT_LEAN || posture == POSTURE_RIGHT_LEAN ||
        posture == POSTURE_FRONT_LEAN || posture == POSTURE_BACK_LEAN;
}

static void commit_stable_posture(posture_class_t posture, int64_t now_ms, const device_runtime_config_t *config)
{
    if (s_stable == posture) return;
    s_stable = posture;
    s_stable_since_ms = now_ms;
    s_next_reminder_ms = posture_is_bad(posture) && config != NULL
        ? now_ms + (int64_t)config->trigger_duration_s * 1000LL
        : 0;
    s_last_reminder_ms = 0;
    s_has_reminded_for_episode = false;
    if (!posture_is_bad(posture)) motor_control_stop();
}

void posture_alert_init(void)
{
    s_stable = POSTURE_UNKNOWN;
    s_candidate = POSTURE_UNKNOWN;
    s_candidate_count = 0;
    s_stable_since_ms = 0;
    s_last_valid_ms = 0;
    s_next_reminder_ms = 0;
    s_last_reminder_ms = 0;
    s_has_reminded_for_episode = false;
    s_reminder_count = 0;
}

void posture_alert_update(
    bool inference_valid,
    posture_class_t predicted_posture,
    float confidence,
    int64_t now_ms,
    const device_runtime_config_t *config,
    posture_alert_status_t *status
)
{
    motor_control_update(now_ms);
    if (config == NULL) return;

    if (inference_valid && predicted_posture == POSTURE_EMPTY) {
        s_last_valid_ms = now_ms;
        s_candidate = POSTURE_UNKNOWN;
        s_candidate_count = 0;
        commit_stable_posture(POSTURE_EMPTY, now_ms, config);
    }

    const bool usable = inference_valid && predicted_posture >= POSTURE_NORMAL &&
        predicted_posture <= POSTURE_BACK_LEAN && confidence >= MIN_CONFIDENCE;
    if (usable) {
        s_last_valid_ms = now_ms;
        if (predicted_posture == s_stable) {
            s_candidate = POSTURE_UNKNOWN;
            s_candidate_count = 0;
        } else if (predicted_posture == s_candidate) {
            s_candidate_count++;
            if (s_candidate_count >= TRANSITION_CONFIRMATIONS) {
                commit_stable_posture(predicted_posture, now_ms, config);
                s_candidate = POSTURE_UNKNOWN;
                s_candidate_count = 0;
            }
        } else {
            s_candidate = predicted_posture;
            s_candidate_count = 1;
        }
    } else if (s_last_valid_ms != 0 && now_ms - s_last_valid_ms > INVALID_GRACE_MS) {
        commit_stable_posture(POSTURE_UNKNOWN, now_ms, config);
        s_candidate = POSTURE_UNKNOWN;
        s_candidate_count = 0;
    }

    if (posture_is_bad(s_stable) && s_stable_since_ms > 0) {
        s_next_reminder_ms = s_has_reminded_for_episode
            ? s_last_reminder_ms + (int64_t)config->cooldown_s * 1000LL
            : s_stable_since_ms + (int64_t)config->trigger_duration_s * 1000LL;
    }
    const bool warning_active = posture_is_bad(s_stable) && s_stable_since_ms > 0 &&
        now_ms - s_stable_since_ms >= (int64_t)config->trigger_duration_s * 1000LL;
    const bool reminder_due = warning_active && s_next_reminder_ms > 0 && now_ms >= s_next_reminder_ms;
    const bool vibration_allowed = device_config_effective_vibration_enabled(config);
    const bool reminder_suppressed = reminder_due && !vibration_allowed;

    if (reminder_due && vibration_allowed && !motor_control_is_active()) {
        const uint32_t duration_ms = config->vibration_duration_s * 1000U;
        if (motor_control_start_for_posture(s_stable, duration_ms, now_ms)) {
            s_reminder_count++;
            s_has_reminded_for_episode = true;
            s_last_reminder_ms = now_ms;
            s_next_reminder_ms = now_ms + (int64_t)config->cooldown_s * 1000LL;
        }
    }

    if (status != NULL) {
        memset(status, 0, sizeof(*status));
        status->stable_posture = s_stable;
        status->stable_duration_s = s_stable_since_ms > 0 ? (uint64_t)(now_ms - s_stable_since_ms) / 1000ULL : 0;
        status->warning_active = warning_active;
        status->reminder_due = reminder_due;
        status->reminder_suppressed = reminder_suppressed;
        status->vibration_active = motor_control_is_active();
        status->cooldown_remaining_s = s_next_reminder_ms > now_ms
            ? (uint32_t)((s_next_reminder_ms - now_ms + 999LL) / 1000LL)
            : 0;
        status->reminder_count = s_reminder_count;
    }
}
