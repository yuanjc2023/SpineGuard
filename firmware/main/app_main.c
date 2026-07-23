#include <stdbool.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <stdio.h>

#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "device_commands.h"
#include "device_config.h"
#include "device_health.h"
#include "device_identity.h"
#include "device_registration.h"
#include "device_ota.h"
#include "fsr_pipeline.h"
#include "motor_control.h"
#include "posture_alert.h"
#include "posture_inference.h"
#include "posture_model.h"
#include "telemetry.h"
#include "vl53l1x_driver.h"
#include "wifi_manager.h"

#define ADC_AVERAGE_SAMPLES 32
#define SAMPLE_INTERVAL_MS 100

#define BASELINE_WAIT_MS 2000
#define BASELINE_WARMUP_ROUNDS 30
#define BASELINE_ROUNDS 100
#define BASELINE_VERIFY_ROUNDS 20
#define BASELINE_ROUND_DELAY_MS 20
#define BASELINE_VERIFY_MAX_DIFF_ADC 120.0f
#define BASELINE_LOAD_ABORT_DELTA_ADC 300.0f

#define EMA_ALPHA 0.25f
#define HEADER_REPEAT_FRAMES 50

static const char *TAG = "spineguard_lgbm";

/* Fixed order: left, right, front, back, center. */
static const adc_channel_t CHANNELS[FSR_COUNT] = {
    ADC_CHANNEL_3, /* GPIO4 left   -> S5 */
    ADC_CHANNEL_4, /* GPIO5 right  -> S4 */
    ADC_CHANNEL_5, /* GPIO6 front  -> S3 */
    ADC_CHANNEL_6, /* GPIO7 back   -> S2 */
    ADC_CHANNEL_7, /* GPIO8 center -> S1 */
};

static float s_ema[FSR_COUNT];
static bool s_ema_initialized[FSR_COUNT];

static void initialize_adc(adc_oneshot_unit_handle_t *adc)
{
    const adc_oneshot_unit_init_cfg_t unit_config = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit_config, adc));

    const adc_oneshot_chan_cfg_t channel_config = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten = ADC_ATTEN_DB_12,
    };
    for (int i = 0; i < FSR_COUNT; ++i) {
        ESP_ERROR_CHECK(adc_oneshot_config_channel(*adc, CHANNELS[i], &channel_config));
    }
}

static int read_adc_mean(adc_oneshot_unit_handle_t adc, adc_channel_t channel)
{
    int64_t sum = 0;
    for (int i = 0; i < ADC_AVERAGE_SAMPLES; ++i) {
        int raw = 0;
        ESP_ERROR_CHECK(adc_oneshot_read(adc, channel, &raw));
        sum += raw;
    }
    return (int)(sum / ADC_AVERAGE_SAMPLES);
}

static float ema_filter(int sensor, int raw_adc)
{
    if (!s_ema_initialized[sensor]) {
        s_ema[sensor] = (float)raw_adc;
        s_ema_initialized[sensor] = true;
        return s_ema[sensor];
    }
    s_ema[sensor] =
        EMA_ALPHA * (float)raw_adc +
        (1.0f - EMA_ALPHA) * s_ema[sensor];
    return s_ema[sensor];
}

static bool collect_empty_baseline(
    adc_oneshot_unit_handle_t adc,
    float baseline[FSR_COUNT],
    bool reject_if_loaded,
    const char *command_id
)
{
    ESP_LOGI(TAG, "Keep cushion empty; baseline starts in %d ms", BASELINE_WAIT_MS);
    vTaskDelay(pdMS_TO_TICKS(BASELINE_WAIT_MS));

    for (int attempt = 0; attempt < 2; ++attempt) {
        int reference[FSR_COUNT] = {0};
        for (int round = 0; round < BASELINE_WARMUP_ROUNDS; ++round) {
            for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
                reference[sensor] = read_adc_mean(adc, CHANNELS[sensor]);
            }
            vTaskDelay(pdMS_TO_TICKS(BASELINE_ROUND_DELAY_MS));
        }

        double sums[FSR_COUNT] = {0};
        for (int round = 0; round < BASELINE_ROUNDS; ++round) {
            for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
                const int value = read_adc_mean(adc, CHANNELS[sensor]);
                if (reject_if_loaded && value - reference[sensor] > BASELINE_LOAD_ABORT_DELTA_ADC) {
                    ESP_LOGW(TAG, "Calibration aborted: seat load detected on %s", fsr_name((fsr_id_t)sensor));
                    return false;
                }
                sums[sensor] += value;
            }
            if (command_id != NULL && round % 10 == 0) {
                device_commands_set_progress(command_id, (uint8_t)(10 + round * 70 / BASELINE_ROUNDS));
            }
            vTaskDelay(pdMS_TO_TICKS(BASELINE_ROUND_DELAY_MS));
        }

        float candidate[FSR_COUNT] = {0};
        for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
            candidate[sensor] = (float)(sums[sensor] / BASELINE_ROUNDS);
        }

        vTaskDelay(pdMS_TO_TICKS(300));
        double verify_sums[FSR_COUNT] = {0};
        for (int round = 0; round < BASELINE_VERIFY_ROUNDS; ++round) {
            for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
                verify_sums[sensor] += read_adc_mean(adc, CHANNELS[sensor]);
            }
            vTaskDelay(pdMS_TO_TICKS(BASELINE_ROUND_DELAY_MS));
        }

        bool stable = true;
        for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
            const float verify = (float)(verify_sums[sensor] / BASELINE_VERIFY_ROUNDS);
            if (fabsf(verify - candidate[sensor]) > BASELINE_VERIFY_MAX_DIFF_ADC) stable = false;
            baseline[sensor] = verify;
        }
        if (stable) {
            for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
                s_ema[sensor] = baseline[sensor];
                s_ema_initialized[sensor] = true;
            }
            ESP_LOGI(TAG, "FSR baseline L=%.2f R=%.2f F=%.2f B=%.2f C=%.2f",
                baseline[FSR_LEFT], baseline[FSR_RIGHT], baseline[FSR_FRONT], baseline[FSR_BACK], baseline[FSR_CENTER]);
            if (command_id != NULL) device_commands_set_progress(command_id, 95);
            return true;
        }
        ESP_LOGW(TAG, "Baseline verification unstable; retrying (%d/2)", attempt + 1);
    }
    return false;
}

static void print_combined_csv_header(void)
{
    printf(
        "HEADER3,"
        "device_time_ms,frame_id,occupied,ratio_valid,"
        "total_adc_delta,total_calibrated_g,"
        "left_raw,left_filtered,left_delta,left_adc_ratio,left_corrected,left_load_s,"
        "left_calibrated_g,left_calibrated_ratio,left_active,left_within_calibration_range,"
        "right_raw,right_filtered,right_delta,right_adc_ratio,right_corrected,right_load_s,"
        "right_calibrated_g,right_calibrated_ratio,right_active,right_within_calibration_range,"
        "front_raw,front_filtered,front_delta,front_adc_ratio,front_corrected,front_load_s,"
        "front_calibrated_g,front_calibrated_ratio,front_active,front_within_calibration_range,"
        "back_raw,back_filtered,back_delta,back_adc_ratio,back_corrected,back_load_s,"
        "back_calibrated_g,back_calibrated_ratio,back_active,back_within_calibration_range,"
        "center_raw,center_filtered,center_delta,center_adc_ratio,center_corrected,center_load_s,"
        "center_calibrated_g,center_calibrated_ratio,center_active,center_within_calibration_range,"
        "tof_online,tof_data_ready,backrest_distance_raw_mm,"
        "backrest_distance_filtered_mm,backrest_distance_valid,"
        "backrest_range_status,backrest_signal_per_spad_kcps,"
        "backrest_ambient_kcps,backrest_spad_count\n"
    );
    fflush(stdout);
}

static void print_combined_csv_row(
    const fsr_frame_t *frame,
    const vl53l1x_sample_t *tof
)
{
    printf(
        "DATA3,%lld,%lu,%d,%d,%.3f,%.3f",
        (long long)frame->device_time_ms,
        (unsigned long)frame->frame_id,
        frame->occupied ? 1 : 0,
        frame->ratio_valid ? 1 : 0,
        frame->total_adc_delta,
        frame->total_calibrated_g
    );

    for (int i = 0; i < FSR_COUNT; ++i) {
        printf(
            ",%d,%.3f,%.3f,%.8f,%.3f,%.3f,%.3f,%.8f,%d,%d",
            frame->raw_adc[i],
            frame->filtered_adc[i],
            frame->adc_delta[i],
            frame->adc_ratio[i],
            frame->corrected_adc[i],
            frame->load_elapsed_s[i],
            frame->calibrated_g[i],
            frame->calibrated_ratio[i],
            frame->active[i] ? 1 : 0,
            frame->within_calibration_range[i] ? 1 : 0
        );
    }

    printf(
        ",%d,%d,%u,%.3f,%d,%u,%u,%u,%u\n",
        tof->online ? 1 : 0,
        tof->data_ready ? 1 : 0,
        (unsigned)tof->distance_raw_mm,
        tof->distance_filtered_mm,
        tof->valid ? 1 : 0,
        (unsigned)tof->range_status,
        (unsigned)tof->signal_per_spad_kcps,
        (unsigned)tof->ambient_kcps,
        (unsigned)tof->spad_count
    );
    fflush(stdout);
}

static void print_prediction(
    int64_t now_ms,
    const posture_inference_result_t *inference,
    const posture_alert_status_t *alert
)
{
    printf(
        "PRED4,%lld,%lu,%s,%.6f,%s,%llu,%d,%d,%d,%lu",
        (long long)now_ms,
        (unsigned long)inference->inference_id,
        posture_model_label(inference->posture),
        inference->confidence,
        posture_model_label(alert->stable_posture),
        (unsigned long long)alert->stable_duration_s,
        motor_control_is_enabled() ? 1 : 0,
        alert->warning_active ? 1 : 0,
        alert->vibration_active ? 1 : 0,
        (unsigned long)alert->reminder_count
    );
    for (int i = 0; i < POSTURE_MODEL_CLASS_COUNT; ++i) {
        printf(",%.8f", inference->probabilities[i]);
    }
    printf("\n");
    fflush(stdout);
}

static float stable_posture_confidence(
    posture_class_t stable_posture,
    const posture_inference_result_t *last_inference
)
{
    if (stable_posture == POSTURE_EMPTY) {
        return 1.0f;
    }
    if (
        last_inference != NULL &&
        last_inference->ready &&
        stable_posture >= POSTURE_NORMAL &&
        stable_posture <= POSTURE_BACK_LEAN
    ) {
        return last_inference->probabilities[(int)stable_posture];
    }
    return 0.0f;
}

static void execute_device_command(
    const device_command_t *command,
    adc_oneshot_unit_handle_t adc,
    const fsr_frame_t *latest_frame,
    float baseline[FSR_COUNT]
)
{
    if (command == NULL) return;
    ESP_LOGW(TAG, "Executing command %s (%s)", command->id, device_command_type_name(command->type));

    if (command->type == DEVICE_COMMAND_CALIBRATE_EMPTY) {
        if (latest_frame == NULL || latest_frame->occupied) {
            ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, false, "seat_not_empty"));
            return;
        }
        motor_control_stop();
        device_commands_set_progress(command->id, 5);
        float candidate[FSR_COUNT] = {0};
        if (!collect_empty_baseline(adc, candidate, true, command->id)) {
            ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, false, "calibration_unstable_or_loaded"));
            return;
        }
        memcpy(baseline, candidate, sizeof(float) * FSR_COUNT);
        fsr_pipeline_init(baseline);
        posture_inference_reset();
        posture_alert_init();
        device_health_reset_baseline(baseline);
        ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, true, ""));
        return;
    }


    if (command->type == DEVICE_COMMAND_OTA_UPDATE) {
        motor_control_stop();
        const esp_err_t err = device_ota_start(command);
        if (err != ESP_OK) {
            ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, false, "ota_start_failed"));
        }
        return;
    }

    if (command->type == DEVICE_COMMAND_ROTATE_CLAIM_CODE) {
        const esp_err_t err = device_identity_rotate_claim_code();
        ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, err == ESP_OK, err == ESP_OK ? "" : "claim_rotation_failed"));
        return;
    }

    if (command->type == DEVICE_COMMAND_RESTART) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, true, ""));
        vTaskDelay(pdMS_TO_TICKS(2500));
        esp_restart();
        return;
    }

    if (command->type == DEVICE_COMMAND_ENTER_PROVISIONING) {
        const esp_err_t err = wifi_manager_clear_saved_config();
        ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, err == ESP_OK, err == ESP_OK ? "" : "wifi_clear_failed"));
        if (err == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(2500));
            esp_restart();
        }
        return;
    }

    if (command->type == DEVICE_COMMAND_FACTORY_RESET) {
        ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, true, ""));
        vTaskDelay(pdMS_TO_TICKS(2500));
        ESP_ERROR_CHECK_WITHOUT_ABORT(nvs_flash_deinit());
        ESP_ERROR_CHECK_WITHOUT_ABORT(nvs_flash_erase());
        esp_restart();
        return;
    }

    ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(command->id, false, "unsupported_command"));
}


static void confirm_running_ota_image_if_needed(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running == NULL) {
        ESP_LOGW(TAG, "Unable to obtain running app partition");
        return;
    }

    const bool is_ota_partition =
        running->type == ESP_PARTITION_TYPE_APP &&
        running->subtype >= ESP_PARTITION_SUBTYPE_APP_OTA_0 &&
        running->subtype <= ESP_PARTITION_SUBTYPE_APP_OTA_15;

    if (!is_ota_partition) {
        ESP_LOGI(
            TAG,
            "Running from %s partition; OTA confirmation skipped",
            running->label
        );
        return;
    }

    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    const esp_err_t state_err = esp_ota_get_state_partition(running, &state);
    if (state_err != ESP_OK) {
        ESP_LOGW(
            TAG,
            "Unable to read OTA image state for %s: %s",
            running->label,
            esp_err_to_name(state_err)
        );
        return;
    }

    if (state != ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(
            TAG,
            "Running OTA partition %s does not require confirmation (state=%d)",
            running->label,
            (int)state
        );
        return;
    }

    const esp_err_t confirm_err = esp_ota_mark_app_valid_cancel_rollback();
    if (confirm_err == ESP_OK) {
        ESP_LOGI(TAG, "OTA image in %s confirmed as valid", running->label);
    } else {
        ESP_LOGW(
            TAG,
            "Unable to confirm OTA image in %s: %s",
            running->label,
            esp_err_to_name(confirm_err)
        );
    }
}

void app_main(void)
{
    adc_oneshot_unit_handle_t adc = NULL;
    initialize_adc(&adc);

    const esp_err_t wifi_result = wifi_manager_start();
    if (wifi_result != ESP_OK) ESP_LOGW(TAG, "Wi-Fi manager unavailable: %s", esp_err_to_name(wifi_result));

    ESP_ERROR_CHECK(device_commands_init());
    ESP_ERROR_CHECK(device_config_init());
    device_runtime_config_t runtime_config;
    device_config_get(&runtime_config);
    motor_control_init(device_config_effective_vibration_enabled(&runtime_config), runtime_config.intensity_percent);
#if CONFIG_SPINEGUARD_MOTOR_SELF_TEST
    motor_control_self_test();
#endif

    const esp_err_t tof_init_result = vl53l1x_init();
    if (tof_init_result != ESP_OK) ESP_LOGW(TAG, "VL53L1X unavailable; FSR output continues: %s", esp_err_to_name(tof_init_result));

    float baseline[FSR_COUNT] = {0};
    const bool baseline_stable = collect_empty_baseline(adc, baseline, false, NULL);
    if (!baseline_stable) ESP_LOGW(TAG, "Boot baseline remained unstable; remote recalibration is recommended");
    fsr_pipeline_init(baseline);
    device_health_init(baseline);
    posture_inference_init();
    posture_alert_init();
    ESP_ERROR_CHECK_WITHOUT_ABORT(telemetry_start());
    ESP_ERROR_CHECK_WITHOUT_ABORT(device_config_start_polling());
    ESP_ERROR_CHECK_WITHOUT_ABORT(device_registration_start());
    confirm_running_ota_image_if_needed();

    ESP_LOGI(TAG, "Model=%s; reminder parameters are remotely configurable; PWM intensity=%u%%", POSTURE_MODEL_VERSION, runtime_config.intensity_percent);
    print_combined_csv_header();

    uint32_t frame_id = 0;
    TickType_t last_wake = xTaskGetTickCount();
    posture_alert_status_t alert_status = {.stable_posture = POSTURE_UNKNOWN};
    posture_inference_result_t last_inference = {.posture = POSTURE_UNKNOWN};
    fsr_frame_t latest_frame = {0};

    while (true) {
        int raw_adc[FSR_COUNT] = {0};
        float filtered_adc[FSR_COUNT] = {0};
        for (int sensor = 0; sensor < FSR_COUNT; ++sensor) {
            raw_adc[sensor] = read_adc_mean(adc, CHANNELS[sensor]);
            filtered_adc[sensor] = ema_filter(sensor, raw_adc[sensor]);
        }

        fsr_frame_t frame;
        fsr_pipeline_process(raw_adc, filtered_adc, esp_timer_get_time(), ++frame_id, &frame);
        latest_frame = frame;

        vl53l1x_sample_t tof_sample = {.online = vl53l1x_is_online(), .range_status = 255};
        if (vl53l1x_is_online()) {
            const esp_err_t read_result = vl53l1x_read(&tof_sample);
            if (read_result != ESP_OK && read_result != ESP_ERR_TIMEOUT && frame_id % HEADER_REPEAT_FRAMES == 1) {
                ESP_LOGW(TAG, "VL53L1X read failed: %s", esp_err_to_name(read_result));
            }
        }
        device_health_update(&frame, &tof_sample);

        posture_inference_result_t inference;
        const bool new_prediction = posture_inference_push(&frame, &tof_sample, &inference);
        if (new_prediction) last_inference = inference;
        const int64_t now_ms = frame.device_time_ms;
        device_config_get(&runtime_config);

        if (!frame.occupied) {
            posture_alert_update(true, POSTURE_EMPTY, 1.0f, now_ms, &runtime_config, &alert_status);
        } else {
            posture_alert_update(new_prediction, new_prediction ? inference.posture : POSTURE_UNKNOWN,
                new_prediction ? inference.confidence : 0.0f, now_ms, &runtime_config, &alert_status);
        }

        telemetry_update_snapshot(&frame, &tof_sample, alert_status.stable_posture,
            stable_posture_confidence(alert_status.stable_posture, &last_inference), &alert_status);
        print_combined_csv_row(&frame, &tof_sample);
        if (new_prediction) print_prediction(now_ms, &inference, &alert_status);
        if (frame_id % HEADER_REPEAT_FRAMES == 0) print_combined_csv_header();

        device_command_t command;
        if (device_commands_take_pending(&command)) {
            execute_device_command(&command, adc, &latest_frame, baseline);
            last_wake = xTaskGetTickCount();
        }
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));
    }
}
