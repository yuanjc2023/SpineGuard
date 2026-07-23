#include "fsr_pipeline.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define FSR_REFERENCE_TIME_S           60.0f
#define FSR_ACTIVE_ON_DELTA_ADC        80.0f
#define FSR_ACTIVE_OFF_DELTA_ADC       40.0f
#define FSR_OCCUPIED_TOTAL_DELTA_ADC  300.0f
#define FSR_RATIO_EPSILON               0.001f
#define FSR_EMPTY_RESET_FRAMES         10

/*
 * 现有标定范围为200g～1000g。
 * 超过1000g后不做无界多项式外推，而使用有界软扩展到1500g，
 * 避免坐姿采集时出现数千克的虚假结果。
 */
#define FSR_MAX_EQUIVALENT_G         1500.0f
#define FSR_TAIL_MIN_ADC_SPAN          80.0f

#define CAL_POINT_COUNT 8

static const float CAL_LOAD_G[CAL_POINT_COUNT] = {
    200.0f, 300.0f, 400.0f, 500.0f,
    600.0f, 700.0f, 800.0f, 1000.0f,
};

typedef struct {
    const char *name;

    /* 550g恒载实验：y(t)=y0+A*(1-exp(-k*t))。 */
    float creep_A;
    float creep_k;

    /*
     * 60s窗口下三次重复测试的中位数ADC。
     * 采用中位数可以降低单次放置偏差和异常试验的影响。
     */
    float adc_at_load[CAL_POINT_COUNT];
} fsr_model_t;

typedef struct {
    bool active;
    int64_t load_start_us;
} fsr_runtime_t;

/*
 * 数组顺序：left=S5，right=S4，front=S3，back=S2，center=S1。
 * 所有参数均来自用户已完成的200g～1000g标定和550g恒载实验。
 */
static const fsr_model_t MODELS[FSR_COUNT] = {
    [FSR_LEFT] = {
        .name = "left",
        .creep_A = 69.237971f,
        .creep_k = 0.003497288f,
        .adc_at_load = {
            2681.900f, 3035.750f, 3154.000f, 3317.500f,
            3431.750f, 3504.500f, 3579.350f, 3669.600f,
        },
    },
    [FSR_RIGHT] = {
        .name = "right",
        .creep_A = 47.717327f,
        .creep_k = 0.004108176f,
        .adc_at_load = {
            2356.550f, 2670.950f, 2769.550f, 2848.400f,
            2892.150f, 2939.100f, 2965.700f, 3014.000f,
        },
    },
    [FSR_FRONT] = {
        .name = "front",
        .creep_A = 55.720108f,
        .creep_k = 0.004494379f,
        .adc_at_load = {
            2485.650f, 2742.900f, 2862.950f, 2918.450f,
            2972.350f, 3010.750f, 3016.700f, 3048.650f,
        },
    },
    [FSR_BACK] = {
        .name = "back",
        .creep_A = 27.335366f,
        .creep_k = 0.004441891f,
        .adc_at_load = {
            2424.100f, 2599.150f, 2659.400f, 2679.950f,
            2733.450f, 2753.650f, 2771.400f, 2798.600f,
        },
    },
    [FSR_CENTER] = {
        .name = "center",
        .creep_A = 33.643996f,
        .creep_k = 0.002950725f,
        .adc_at_load = {
            2454.500f, 2591.650f, 2643.050f, 2690.450f,
            2711.350f, 2731.950f, 2747.048f, 2769.600f,
        },
    },
};

static float s_baseline_adc[FSR_COUNT];
static fsr_runtime_t s_runtime[FSR_COUNT];
static int s_empty_frame_count;

static float clamp_float(float value, float minimum, float maximum)
{
    if (value < minimum) {
        return minimum;
    }
    if (value > maximum) {
        return maximum;
    }
    return value;
}

static float max_float(float a, float b)
{
    return a > b ? a : b;
}

static float creep_correct_to_60s(
    float filtered_adc,
    float elapsed_s,
    const fsr_model_t *model
)
{
    elapsed_s = max_float(elapsed_s, 0.0f);

    /*
     * corrected=filtered+A*(exp(-k*t)-exp(-k*60))
     * t<60s时向60s稳定值补偿；t>60s时向60s参考值回校。
     */
    const float correction =
        model->creep_A *
        (
            expf(-model->creep_k * elapsed_s) -
            expf(-model->creep_k * FSR_REFERENCE_TIME_S)
        );

    return filtered_adc + correction;
}

static float interpolate(
    float x,
    float x0,
    float x1,
    float y0,
    float y1
)
{
    const float span = x1 - x0;
    if (fabsf(span) < 0.0001f) {
        return (y0 + y1) * 0.5f;
    }

    const float ratio = clamp_float((x - x0) / span, 0.0f, 1.0f);
    return y0 + ratio * (y1 - y0);
}

static float adc_to_calibrated_g(
    float corrected_adc,
    float baseline_adc,
    const fsr_model_t *model,
    bool *within_range
)
{
    *within_range = false;

    if (corrected_adc <= baseline_adc + FSR_ACTIVE_OFF_DELTA_ADC) {
        return 0.0f;
    }

    const float adc_200 = model->adc_at_load[0];
    const float adc_1000 = model->adc_at_load[CAL_POINT_COUNT - 1];

    /* 0g～200g无实测点，使用开机空载基线到200g点的线性估计。 */
    if (corrected_adc < adc_200) {
        return interpolate(
            corrected_adc,
            baseline_adc,
            adc_200,
            0.0f,
            200.0f
        );
    }

    for (int i = 0; i < CAL_POINT_COUNT - 1; ++i) {
        const float x0 = model->adc_at_load[i];
        const float x1 = model->adc_at_load[i + 1];

        if (corrected_adc <= x1) {
            *within_range = true;
            return interpolate(
                corrected_adc,
                x0,
                x1,
                CAL_LOAD_G[i],
                CAL_LOAD_G[i + 1]
            );
        }
    }

    /*
     * 1000g以上只进行有界软扩展。
     * tail_span至少80ADC，避免高负载区曲线过平时把少量ADC噪声
     * 放大成数千克。
     */
    const float adc_800 = model->adc_at_load[CAL_POINT_COUNT - 2];
    const float tail_span = max_float(
        adc_1000 - adc_800,
        FSR_TAIL_MIN_ADC_SPAN
    );
    const float excess_adc = max_float(corrected_adc - adc_1000, 0.0f);
    const float extension =
        (FSR_MAX_EQUIVALENT_G - 1000.0f) *
        (1.0f - expf(-excess_adc / tail_span));

    return clamp_float(
        1000.0f + extension,
        1000.0f,
        FSR_MAX_EQUIVALENT_G
    );
}

const char *fsr_name(fsr_id_t id)
{
    if (id < 0 || id >= FSR_COUNT) {
        return "unknown";
    }
    return MODELS[id].name;
}

void fsr_pipeline_reset_runtime(void)
{
    memset(s_runtime, 0, sizeof(s_runtime));
    s_empty_frame_count = 0;
}

void fsr_pipeline_init(const float baseline_adc[FSR_COUNT])
{
    memcpy(s_baseline_adc, baseline_adc, sizeof(s_baseline_adc));
    fsr_pipeline_reset_runtime();
}

void fsr_pipeline_process(
    const int raw_adc[FSR_COUNT],
    const float filtered_adc[FSR_COUNT],
    int64_t now_us,
    uint32_t frame_id,
    fsr_frame_t *out
)
{
    memset(out, 0, sizeof(*out));

    out->device_time_ms = now_us / 1000;
    out->frame_id = frame_id;

    int active_count = 0;

    for (int i = 0; i < FSR_COUNT; ++i) {
        const fsr_model_t *model = &MODELS[i];
        fsr_runtime_t *runtime = &s_runtime[i];

        out->raw_adc[i] = raw_adc[i];
        out->filtered_adc[i] = filtered_adc[i];
        out->corrected_adc[i] = filtered_adc[i];
        out->load_elapsed_s[i] = -1.0f;

        float adc_delta = filtered_adc[i] - s_baseline_adc[i];
        if (adc_delta < 0.0f) {
            adc_delta = 0.0f;
        }

        out->adc_delta[i] = adc_delta;
        out->total_adc_delta += adc_delta;

        if (!runtime->active && adc_delta >= FSR_ACTIVE_ON_DELTA_ADC) {
            runtime->active = true;
            runtime->load_start_us = now_us;
        } else if (runtime->active && adc_delta <= FSR_ACTIVE_OFF_DELTA_ADC) {
            runtime->active = false;
            runtime->load_start_us = 0;
        }

        out->active[i] = runtime->active;
        if (!runtime->active) {
            continue;
        }

        active_count++;

        const float elapsed_s =
            (float)(now_us - runtime->load_start_us) / 1000000.0f;

        out->load_elapsed_s[i] = elapsed_s;
        out->corrected_adc[i] = creep_correct_to_60s(
            filtered_adc[i],
            elapsed_s,
            model
        );

        out->calibrated_g[i] = adc_to_calibrated_g(
            out->corrected_adc[i],
            s_baseline_adc[i],
            model,
            &out->within_calibration_range[i]
        );

        out->total_calibrated_g += out->calibrated_g[i];
    }

    out->occupied =
        active_count > 0 &&
        out->total_adc_delta >= FSR_OCCUPIED_TOTAL_DELTA_ADC;

    if (out->occupied && out->total_adc_delta > FSR_RATIO_EPSILON) {
        for (int i = 0; i < FSR_COUNT; ++i) {
            out->adc_ratio[i] =
                out->adc_delta[i] / out->total_adc_delta;
        }
    }

    out->ratio_valid =
        out->occupied &&
        out->total_calibrated_g > FSR_RATIO_EPSILON;

    if (out->ratio_valid) {
        for (int i = 0; i < FSR_COUNT; ++i) {
            out->calibrated_ratio[i] =
                out->calibrated_g[i] / out->total_calibrated_g;
        }
    }

    if (!out->occupied) {
        s_empty_frame_count++;
        if (s_empty_frame_count >= FSR_EMPTY_RESET_FRAMES) {
            memset(s_runtime, 0, sizeof(s_runtime));
            s_empty_frame_count = 0;
        }
    } else {
        s_empty_frame_count = 0;
    }
}

void fsr_pipeline_print_csv_header(void)
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
        "center_calibrated_g,center_calibrated_ratio,center_active,center_within_calibration_range"
        "\n"
    );
    fflush(stdout);
}

void fsr_pipeline_print_csv_row(const fsr_frame_t *frame)
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

    printf("\n");
    fflush(stdout);
}
