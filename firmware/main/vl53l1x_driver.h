#ifndef SPINEGUARD_VL53L1X_DRIVER_H
#define SPINEGUARD_VL53L1X_DRIVER_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 当前项目固定接线：
 * VL53L1X SCL -> ESP32-S3 GPIO10
 * VL53L1X SDA -> ESP32-S3 GPIO11
 * 7位I2C地址：0x29
 */
#define VL53L1X_SCL_GPIO 10
#define VL53L1X_SDA_GPIO 11
#define VL53L1X_I2C_ADDRESS_7BIT 0x29

typedef struct {
    bool online;
    bool data_ready;
    bool valid;

    uint16_t distance_raw_mm;
    float distance_filtered_mm;
    uint8_t range_status;

    uint16_t signal_per_spad_kcps;
    uint16_t ambient_kcps;
    uint16_t spad_count;
} vl53l1x_sample_t;

/* 初始化I2C和VL53L1X。失败时不会影响五路FSR继续运行。 */
esp_err_t vl53l1x_init(void);

/*
 * 尝试取得一帧新测距数据，最多等待约25ms。
 * ESP_OK：读到了一帧结果；
 * ESP_ERR_TIMEOUT：本周期没有新数据；
 * 其他错误：I2C通信失败。
 */
esp_err_t vl53l1x_read(vl53l1x_sample_t *out);

bool vl53l1x_is_online(void);

#ifdef __cplusplus
}
#endif

#endif
