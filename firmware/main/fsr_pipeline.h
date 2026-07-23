#ifndef SPINEGUARD_FSR_PIPELINE_H
#define SPINEGUARD_FSR_PIPELINE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FSR_COUNT 5

/*
 * 固定数组顺序、坐垫区域、GPIO和传感器编号：
 * 0 left   -> GPIO4 -> S5
 * 1 right  -> GPIO5 -> S4
 * 2 front  -> GPIO6 -> S3
 * 3 back   -> GPIO7 -> S2
 * 4 center -> GPIO8 -> S1
 */
typedef enum {
    FSR_LEFT = 0,
    FSR_RIGHT,
    FSR_FRONT,
    FSR_BACK,
    FSR_CENTER,
} fsr_id_t;

typedef struct {
    int raw_adc[FSR_COUNT];
    float filtered_adc[FSR_COUNT];

    /* 空载基线修正后的ADC增量及其原始占比。 */
    float adc_delta[FSR_COUNT];
    float adc_ratio[FSR_COUNT];

    /* 由550g恒载数据补偿到加载后60s参考时刻的ADC。 */
    float corrected_adc[FSR_COUNT];
    float load_elapsed_s[FSR_COUNT];

    /*
     * calibrated_g不是人体真实重量，而是按每个FSR独立标定曲线
     * 换算出的“等效载荷”。它用于消除五个传感器的灵敏度差异。
     */
    float calibrated_g[FSR_COUNT];
    float calibrated_ratio[FSR_COUNT];

    bool active[FSR_COUNT];
    bool within_calibration_range[FSR_COUNT];

    bool occupied;
    bool ratio_valid;

    float total_adc_delta;
    float total_calibrated_g;

    int64_t device_time_ms;
    uint32_t frame_id;
} fsr_frame_t;

/* 开机空载基线采集完成后调用。 */
void fsr_pipeline_init(const float baseline_adc[FSR_COUNT]);

/* 清除五路受压状态和计时器。 */
void fsr_pipeline_reset_runtime(void);

void fsr_pipeline_process(
    const int raw_adc[FSR_COUNT],
    const float filtered_adc[FSR_COUNT],
    int64_t now_us,
    uint32_t frame_id,
    fsr_frame_t *out
);

void fsr_pipeline_print_csv_header(void);
void fsr_pipeline_print_csv_row(const fsr_frame_t *frame);

const char *fsr_name(fsr_id_t id);

#ifdef __cplusplus
}
#endif

#endif
