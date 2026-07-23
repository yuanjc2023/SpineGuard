#include "motor_control.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#define MOTOR_LEFT_GPIO  GPIO_NUM_15
#define MOTOR_FRONT_GPIO GPIO_NUM_16
#define MOTOR_RIGHT_GPIO GPIO_NUM_17
#define MOTOR_BACK_GPIO  GPIO_NUM_18
#define MOTOR_PWM_MODE LEDC_LOW_SPEED_MODE
#define MOTOR_PWM_TIMER LEDC_TIMER_0
#define MOTOR_PWM_RESOLUTION LEDC_TIMER_10_BIT
#define MOTOR_PWM_MAX_DUTY ((1U << 10U) - 1U)

static const char *TAG = "motor";
static bool s_enabled;
static bool s_active;
static bool s_ready;
static bool s_self_test_completed;
static uint8_t s_intensity_percent;
static ledc_channel_t s_active_channel = LEDC_CHANNEL_MAX;
static int64_t s_stop_at_ms;

typedef struct {
    gpio_num_t gpio;
    ledc_channel_t channel;
    posture_class_t posture;
    const char *position;
} motor_channel_t;

static const motor_channel_t MOTOR_CHANNELS[] = {
    {MOTOR_LEFT_GPIO, LEDC_CHANNEL_0, POSTURE_LEFT_LEAN, "left"},
    {MOTOR_FRONT_GPIO, LEDC_CHANNEL_1, POSTURE_FRONT_LEAN, "front"},
    {MOTOR_RIGHT_GPIO, LEDC_CHANNEL_2, POSTURE_RIGHT_LEAN, "right"},
    {MOTOR_BACK_GPIO, LEDC_CHANNEL_3, POSTURE_BACK_LEAN, "back"},
};

static uint8_t clamp_intensity(uint8_t percent)
{
    if (percent > CONFIG_SPINEGUARD_VIBRATION_MAX_PERCENT) {
        return CONFIG_SPINEGUARD_VIBRATION_MAX_PERCENT;
    }
    return percent;
}

static uint32_t duty_for_intensity(uint8_t percent)
{
    return (MOTOR_PWM_MAX_DUTY * (uint32_t)percent) / 100U;
}

static void channel_duty(ledc_channel_t channel, uint32_t duty)
{
    ESP_ERROR_CHECK_WITHOUT_ABORT(ledc_set_duty(MOTOR_PWM_MODE, channel, duty));
    ESP_ERROR_CHECK_WITHOUT_ABORT(ledc_update_duty(MOTOR_PWM_MODE, channel));
}

static void all_off(void)
{
    for (size_t i = 0; i < sizeof(MOTOR_CHANNELS) / sizeof(MOTOR_CHANNELS[0]); ++i) {
        channel_duty(MOTOR_CHANNELS[i].channel, 0);
    }
    s_active = false;
    s_active_channel = LEDC_CHANNEL_MAX;
    s_stop_at_ms = 0;
}

static const motor_channel_t *channel_for_posture(posture_class_t posture)
{
    for (size_t i = 0; i < sizeof(MOTOR_CHANNELS) / sizeof(MOTOR_CHANNELS[0]); ++i) {
        if (MOTOR_CHANNELS[i].posture == posture) return &MOTOR_CHANNELS[i];
    }
    return NULL;
}

void motor_control_init(bool enabled, uint8_t intensity_percent)
{
    const ledc_timer_config_t timer = {
        .speed_mode = MOTOR_PWM_MODE,
        .duty_resolution = MOTOR_PWM_RESOLUTION,
        .timer_num = MOTOR_PWM_TIMER,
        .freq_hz = CONFIG_SPINEGUARD_MOTOR_PWM_FREQUENCY_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    for (size_t i = 0; i < sizeof(MOTOR_CHANNELS) / sizeof(MOTOR_CHANNELS[0]); ++i) {
        const ledc_channel_config_t channel = {
            .gpio_num = MOTOR_CHANNELS[i].gpio,
            .speed_mode = MOTOR_PWM_MODE,
            .channel = MOTOR_CHANNELS[i].channel,
            .intr_type = LEDC_INTR_DISABLE,
            .timer_sel = MOTOR_PWM_TIMER,
            .duty = 0,
            .hpoint = 0,
        };
        ESP_ERROR_CHECK(ledc_channel_config(&channel));
    }

    s_enabled = enabled;
    s_intensity_percent = clamp_intensity(intensity_percent);
    s_ready = true;
    s_self_test_completed = false;
    all_off();
    ESP_LOGI(TAG, "PWM motor control ready: enabled=%d intensity=%u%% max=%u%%", enabled, s_intensity_percent, CONFIG_SPINEGUARD_VIBRATION_MAX_PERCENT);
}

void motor_control_set_enabled(bool enabled)
{
    if (s_enabled == enabled) return;
    s_enabled = enabled;
    if (!enabled) all_off();
    ESP_LOGI(TAG, "Effective vibration output %s", enabled ? "enabled" : "disabled");
}

void motor_control_set_intensity(uint8_t intensity_percent)
{
    s_intensity_percent = clamp_intensity(intensity_percent);
    if (s_active && s_active_channel != LEDC_CHANNEL_MAX) {
        channel_duty(s_active_channel, duty_for_intensity(s_intensity_percent));
    }
    ESP_LOGI(TAG, "Vibration intensity set to %u%%", s_intensity_percent);
}

bool motor_control_is_enabled(void) { return s_enabled; }
bool motor_control_is_active(void) { return s_active; }
bool motor_control_is_ready(void) { return s_ready; }
bool motor_control_self_test_completed(void) { return s_self_test_completed; }
uint8_t motor_control_intensity_percent(void) { return s_intensity_percent; }

const char *motor_control_active_position(void)
{
    if (!s_active) return NULL;
    for (size_t i = 0; i < sizeof(MOTOR_CHANNELS) / sizeof(MOTOR_CHANNELS[0]); ++i) {
        if (MOTOR_CHANNELS[i].channel == s_active_channel) return MOTOR_CHANNELS[i].position;
    }
    return NULL;
}

bool motor_control_start_for_posture(posture_class_t posture, uint32_t duration_ms, int64_t now_ms)
{
    if (!s_ready || !s_enabled || duration_ms == 0 || s_intensity_percent == 0) return false;
    const motor_channel_t *motor = channel_for_posture(posture);
    if (motor == NULL) return false;
    all_off();
    channel_duty(motor->channel, duty_for_intensity(s_intensity_percent));
    s_active = true;
    s_active_channel = motor->channel;
    s_stop_at_ms = now_ms + (int64_t)duration_ms;
    ESP_LOGW(TAG, "Started %s motor for %lu ms at %u%%", posture_model_label(posture), (unsigned long)duration_ms, s_intensity_percent);
    return true;
}

void motor_control_stop(void)
{
    if (s_active) ESP_LOGI(TAG, "Vibration stopped");
    all_off();
}

void motor_control_update(int64_t now_ms)
{
    if (s_active && (!s_enabled || now_ms >= s_stop_at_ms)) motor_control_stop();
}

void motor_control_self_test(void)
{
    if (!s_ready || !s_enabled || s_intensity_percent == 0) {
        s_self_test_completed = true;
        return;
    }
    ESP_LOGI(TAG, "Starting four-motor PWM self-test: left/front/right/back");
    for (size_t i = 0; i < sizeof(MOTOR_CHANNELS) / sizeof(MOTOR_CHANNELS[0]); ++i) {
        all_off();
        channel_duty(MOTOR_CHANNELS[i].channel, duty_for_intensity(s_intensity_percent));
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    all_off();
    s_self_test_completed = true;
}
