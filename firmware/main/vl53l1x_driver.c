/*
 * SpineGuard VL53L1X driver for ESP-IDF using software I2C.
 *
 * The software-I2C transaction sequence follows the customer STM32 example:
 *   write address 0x52 -> 16-bit register address -> repeated START
 *   -> read address 0x53 -> data.
 *
 * The VL53L1X register initialization table and ranging procedure are derived
 * from STMicroelectronics VL53L1X Ultra Lite Driver (STSW-IMG009), BSD-3-Clause.
 */

#include "vl53l1x_driver.h"

#include <stddef.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Customer code uses the 8-bit I2C forms 0x52(write) and 0x53(read). */
#define VL53L1X_I2C_WRITE_ADDRESS_8BIT 0x52U
#define VL53L1X_I2C_READ_ADDRESS_8BIT  0x53U

/* 5 us high + 5 us low gives about 100 kHz. Slower than customer 400 kHz,
 * but more tolerant of long jumper wires during debugging. */
#define SW_I2C_HALF_PERIOD_US          5U
#define SW_I2C_CLOCK_STRETCH_US        2000U

#define VL53L1X_MODEL_ID_REG           0x010FU
#define VL53L1X_EXPECTED_MODEL_ID      0xEACCU
#define VL53L1X_BOOT_STATUS_REG        0x00E5U

#define REG_GPIO_HV_MUX_CTRL           0x0030U
#define REG_GPIO_TIO_HV_STATUS         0x0031U
#define REG_PHASECAL_TIMEOUT_MACROP    0x004BU
#define REG_RANGE_TIMEOUT_A            0x005EU
#define REG_VCSEL_PERIOD_A             0x0060U
#define REG_RANGE_TIMEOUT_B            0x0061U
#define REG_VCSEL_PERIOD_B             0x0063U
#define REG_VALID_PHASE_HIGH           0x0069U
#define REG_INTERMEASUREMENT_PERIOD    0x006CU
#define REG_WOI_SD0                    0x0078U
#define REG_INITIAL_PHASE_SD0          0x007AU
#define REG_INTERRUPT_CLEAR            0x0086U
#define REG_MODE_START                 0x0087U
#define REG_RESULT_RANGE_STATUS        0x0089U
#define REG_OSC_CALIBRATE_VAL          0x00DEU
#define REG_VHV_TIMEOUT                0x0008U

#define TOF_TIMING_BUDGET_MS           50U
#define TOF_INTERMEASUREMENT_MS        100U
#define TOF_READY_WAIT_MS              30U
#define TOF_DISTANCE_MIN_MM            40U
#define TOF_DISTANCE_MAX_MM            4000U
#define TOF_EMA_ALPHA                  0.25f

static const char *TAG = "vl53l1x_sw_i2c";

static bool s_online;
static bool s_distance_ema_initialized;
static float s_distance_ema_mm;

/* Registers 0x2D through 0x87, from ST VL53L1X ULD. */
static const uint8_t DEFAULT_CONFIGURATION[] = {
    0x00, 0x01, 0x00, 0x01, 0x02, 0x00, 0x02, 0x08,
    0x00, 0x08, 0x10, 0x01, 0x01, 0x00, 0x00, 0x00,
    0x00, 0xFF, 0x00, 0x0F, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x20, 0x0B, 0x00, 0x00, 0x02, 0x0A, 0x21,
    0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0xC8,
    0x00, 0x00, 0x38, 0xFF, 0x01, 0x00, 0x08, 0x00,
    0x00, 0x01, 0xCC, 0x0F, 0x01, 0xF1, 0x0D, 0x01,
    0x68, 0x00, 0x80, 0x08, 0xB8, 0x00, 0x00, 0x00,
    0x00, 0x0F, 0x89, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x0F, 0x0D, 0x0E, 0x0E, 0x00,
    0x00, 0x02, 0xC7, 0xFF, 0x9B, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00,
};

static const uint8_t RANGE_STATUS_MAP[24] = {
    255, 255, 255, 5, 2, 4, 1, 7, 3, 0,
    255, 255, 9, 13, 255, 255, 255, 255, 10, 6,
    255, 255, 11, 12,
};

static inline void i2c_delay(void)
{
    esp_rom_delay_us(SW_I2C_HALF_PERIOD_US);
}

/* Open-drain output: writing 1 releases the line; writing 0 pulls it low. */
static inline void sda_release(void)
{
    gpio_set_level(VL53L1X_SDA_GPIO, 1);
}

static inline void sda_low(void)
{
    gpio_set_level(VL53L1X_SDA_GPIO, 0);
}

static inline void scl_release(void)
{
    gpio_set_level(VL53L1X_SCL_GPIO, 1);
}

static inline void scl_low(void)
{
    gpio_set_level(VL53L1X_SCL_GPIO, 0);
}

static bool wait_gpio_high(gpio_num_t pin, uint32_t timeout_us)
{
    for (uint32_t elapsed = 0; elapsed < timeout_us; ++elapsed) {
        if (gpio_get_level(pin) != 0) {
            return true;
        }
        esp_rom_delay_us(1);
    }
    return false;
}

static esp_err_t sw_i2c_gpio_init(void)
{
    const gpio_config_t config = {
        .pin_bit_mask =
            (1ULL << VL53L1X_SDA_GPIO) |
            (1ULL << VL53L1X_SCL_GPIO),
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) {
        return err;
    }

    sda_release();
    scl_release();
    vTaskDelay(pdMS_TO_TICKS(20));
    return ESP_OK;
}

/* Release a slave that was interrupted while holding SDA low. */
static esp_err_t sw_i2c_bus_recover(void)
{
    sda_release();
    scl_release();
    i2c_delay();

    if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
        return ESP_ERR_TIMEOUT;
    }

    if (gpio_get_level(VL53L1X_SDA_GPIO) != 0) {
        return ESP_OK;
    }

    for (int pulse = 0; pulse < 9; ++pulse) {
        scl_low();
        i2c_delay();
        scl_release();
        if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
            return ESP_ERR_TIMEOUT;
        }
        i2c_delay();
    }

    /* STOP condition. */
    sda_low();
    i2c_delay();
    scl_release();
    if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
        return ESP_ERR_TIMEOUT;
    }
    i2c_delay();
    sda_release();
    i2c_delay();

    return gpio_get_level(VL53L1X_SDA_GPIO) != 0
        ? ESP_OK
        : ESP_ERR_TIMEOUT;
}

static esp_err_t sw_i2c_start(void)
{
    sda_release();
    scl_release();

    if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
        return ESP_ERR_TIMEOUT;
    }

    i2c_delay();
    if (gpio_get_level(VL53L1X_SDA_GPIO) == 0) {
        return ESP_ERR_TIMEOUT;
    }

    sda_low();
    i2c_delay();
    scl_low();
    i2c_delay();
    return ESP_OK;
}

static void sw_i2c_stop(void)
{
    scl_low();
    sda_low();
    i2c_delay();

    scl_release();
    (void)wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US);
    i2c_delay();

    sda_release();
    i2c_delay();
}

static esp_err_t sw_i2c_write_byte(uint8_t value, bool *acked)
{
    if (acked == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    for (int bit = 7; bit >= 0; --bit) {
        scl_low();
        if ((value & (1U << bit)) != 0) {
            sda_release();
        } else {
            sda_low();
        }
        i2c_delay();

        scl_release();
        if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
            return ESP_ERR_TIMEOUT;
        }
        i2c_delay();
    }

    scl_low();
    sda_release();
    i2c_delay();

    scl_release();
    if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
        return ESP_ERR_TIMEOUT;
    }
    i2c_delay();
    *acked = gpio_get_level(VL53L1X_SDA_GPIO) == 0;

    scl_low();
    i2c_delay();
    return ESP_OK;
}

static esp_err_t sw_i2c_read_byte(uint8_t *value, bool send_ack)
{
    if (value == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t result = 0;
    sda_release();

    for (int bit = 7; bit >= 0; --bit) {
        scl_low();
        i2c_delay();

        scl_release();
        if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
            return ESP_ERR_TIMEOUT;
        }
        i2c_delay();

        if (gpio_get_level(VL53L1X_SDA_GPIO) != 0) {
            result |= (uint8_t)(1U << bit);
        }
    }

    scl_low();
    if (send_ack) {
        sda_low();
    } else {
        sda_release();
    }
    i2c_delay();

    scl_release();
    if (!wait_gpio_high(VL53L1X_SCL_GPIO, SW_I2C_CLOCK_STRETCH_US)) {
        return ESP_ERR_TIMEOUT;
    }
    i2c_delay();
    scl_low();
    sda_release();
    i2c_delay();

    *value = result;
    return ESP_OK;
}

static esp_err_t send_byte_expect_ack(uint8_t value)
{
    bool acked = false;
    esp_err_t err = sw_i2c_write_byte(value, &acked);
    if (err != ESP_OK) {
        return err;
    }
    return acked ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static esp_err_t write_bytes(uint16_t reg, const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = sw_i2c_start();
    if (err != ESP_OK) {
        return err;
    }

    err = send_byte_expect_ack(VL53L1X_I2C_WRITE_ADDRESS_8BIT);
    if (err == ESP_OK) err = send_byte_expect_ack((uint8_t)(reg >> 8));
    if (err == ESP_OK) err = send_byte_expect_ack((uint8_t)reg);

    for (size_t i = 0; i < len && err == ESP_OK; ++i) {
        err = send_byte_expect_ack(data[i]);
    }

    sw_i2c_stop();
    return err;
}

static esp_err_t read_bytes(uint16_t reg, uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = sw_i2c_start();
    if (err != ESP_OK) {
        return err;
    }

    err = send_byte_expect_ack(VL53L1X_I2C_WRITE_ADDRESS_8BIT);
    if (err == ESP_OK) err = send_byte_expect_ack((uint8_t)(reg >> 8));
    if (err == ESP_OK) err = send_byte_expect_ack((uint8_t)reg);

    if (err == ESP_OK) {
        /* Repeated START, matching the customer software-I2C code. */
        err = sw_i2c_start();
    }
    if (err == ESP_OK) {
        err = send_byte_expect_ack(VL53L1X_I2C_READ_ADDRESS_8BIT);
    }

    for (size_t i = 0; i < len && err == ESP_OK; ++i) {
        err = sw_i2c_read_byte(&data[i], i + 1U < len);
    }

    sw_i2c_stop();
    return err;
}

static esp_err_t write_u8(uint16_t reg, uint8_t value)
{
    return write_bytes(reg, &value, 1);
}

static esp_err_t write_u16(uint16_t reg, uint16_t value)
{
    const uint8_t data[2] = {
        (uint8_t)(value >> 8),
        (uint8_t)value,
    };
    return write_bytes(reg, data, sizeof(data));
}

static esp_err_t write_u32(uint16_t reg, uint32_t value)
{
    const uint8_t data[4] = {
        (uint8_t)(value >> 24),
        (uint8_t)(value >> 16),
        (uint8_t)(value >> 8),
        (uint8_t)value,
    };
    return write_bytes(reg, data, sizeof(data));
}

static esp_err_t read_u8(uint16_t reg, uint8_t *value)
{
    return read_bytes(reg, value, 1);
}

static esp_err_t read_u16(uint16_t reg, uint16_t *value)
{
    if (value == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t data[2] = {0};
    esp_err_t err = read_bytes(reg, data, sizeof(data));
    if (err == ESP_OK) {
        *value = ((uint16_t)data[0] << 8) | data[1];
    }
    return err;
}

static esp_err_t address_ack_test(uint8_t address_7bit)
{
    esp_err_t err = sw_i2c_start();
    if (err != ESP_OK) {
        return err;
    }

    bool acked = false;
    err = sw_i2c_write_byte((uint8_t)(address_7bit << 1), &acked);
    sw_i2c_stop();

    if (err != ESP_OK) {
        return err;
    }
    return acked ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static void scan_i2c_bus(void)
{
    bool found_any = false;
    ESP_LOGI(TAG, "开始软件I2C地址扫描（客服协议格式）");

    for (uint8_t address = 0x08; address <= 0x77; ++address) {
        esp_err_t err = address_ack_test(address);
        if (err == ESP_OK) {
            ESP_LOGI(
                TAG,
                "发现I2C设备：7位地址=0x%02X，8位写地址=0x%02X",
                address,
                (unsigned)(address << 1)
            );
            found_any = true;
        } else if (err == ESP_ERR_TIMEOUT) {
            ESP_LOGW(
                TAG,
                "扫描0x%02X时总线超时：SCL=%d SDA=%d",
                address,
                gpio_get_level(VL53L1X_SCL_GPIO),
                gpio_get_level(VL53L1X_SDA_GPIO)
            );
            break;
        }
    }

    if (!found_any) {
        ESP_LOGW(TAG, "软件I2C扫描未发现任何设备");
    }
}

static esp_err_t wait_for_boot(void)
{
    for (int elapsed_ms = 0; elapsed_ms < 1000; elapsed_ms += 5) {
        uint8_t status = 0;
        esp_err_t err = read_u8(VL53L1X_BOOT_STATUS_REG, &status);
        if (err != ESP_OK) {
            return err;
        }
        if ((status & 0x01U) != 0) {
            ESP_LOGI(TAG, "VL53L1X启动状态寄存器=0x%02X", status);
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return ESP_ERR_TIMEOUT;
}

static esp_err_t check_data_ready(bool *ready)
{
    if (ready == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t mux = 0;
    uint8_t gpio_status = 0;

    esp_err_t err = read_u8(REG_GPIO_HV_MUX_CTRL, &mux);
    if (err != ESP_OK) return err;

    err = read_u8(REG_GPIO_TIO_HV_STATUS, &gpio_status);
    if (err != ESP_OK) return err;

    const uint8_t interrupt_polarity = (uint8_t)!((mux >> 4) & 0x01U);
    *ready = ((gpio_status & 0x01U) == interrupt_polarity);
    return ESP_OK;
}

static esp_err_t wait_for_data_ready(int timeout_ms)
{
    for (int elapsed = 0; elapsed < timeout_ms; ++elapsed) {
        bool ready = false;
        esp_err_t err = check_data_ready(&ready);
        if (err != ESP_OK) return err;
        if (ready) return ESP_OK;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return ESP_ERR_TIMEOUT;
}

static esp_err_t load_default_configuration(void)
{
    const size_t expected_size = 0x87U - 0x2DU + 1U;
    if (sizeof(DEFAULT_CONFIGURATION) != expected_size) {
        ESP_LOGE(TAG, "默认配置长度错误：%u", (unsigned)sizeof(DEFAULT_CONFIGURATION));
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t i = 0; i < sizeof(DEFAULT_CONFIGURATION); ++i) {
        esp_err_t err = write_u8(
            (uint16_t)(0x2DU + i),
            DEFAULT_CONFIGURATION[i]
        );
        if (err != ESP_OK) {
            ESP_LOGE(
                TAG,
                "写入默认配置失败：reg=0x%04X err=%s",
                (unsigned)(0x2DU + i),
                esp_err_to_name(err)
            );
            return err;
        }
    }
    return ESP_OK;
}

static esp_err_t sensor_init_sequence(void)
{
    /* Customer example waits for device boot before DataInit/StaticInit. */
    esp_err_t err = wait_for_boot();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "等待VL53L1X启动失败：%s", esp_err_to_name(err));
        return err;
    }

    uint16_t model_id = 0;
    err = read_u16(VL53L1X_MODEL_ID_REG, &model_id);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "读取型号寄存器失败：%s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "VL53L1X型号寄存器0x010F=0x%04X", model_id);
    if (model_id != VL53L1X_EXPECTED_MODEL_ID) {
        ESP_LOGE(
            TAG,
            "型号不匹配：期望0x%04X，实际0x%04X",
            VL53L1X_EXPECTED_MODEL_ID,
            model_id
        );
        return ESP_ERR_INVALID_RESPONSE;
    }

    err = load_default_configuration();
    if (err != ESP_OK) return err;

    /* ST ULD SensorInit performs one first ranging cycle. */
    err = write_u8(REG_MODE_START, 0x40);
    if (err != ESP_OK) return err;

    err = wait_for_data_ready(1000);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "初始化首帧测距超时");
        return err;
    }

    err = write_u8(REG_INTERRUPT_CLEAR, 0x01);
    if (err != ESP_OK) return err;
    err = write_u8(REG_MODE_START, 0x00);
    if (err != ESP_OK) return err;

    err = write_u8(REG_VHV_TIMEOUT, 0x09);
    if (err != ESP_OK) return err;
    err = write_u8(0x000B, 0x00);
    if (err != ESP_OK) return err;

    /* Match the customer example: long-distance mode. */
    err = write_u8(REG_PHASECAL_TIMEOUT_MACROP, 0x0A);
    if (err != ESP_OK) return err;
    err = write_u8(REG_VCSEL_PERIOD_A, 0x0F);
    if (err != ESP_OK) return err;
    err = write_u8(REG_VCSEL_PERIOD_B, 0x0D);
    if (err != ESP_OK) return err;
    err = write_u8(REG_VALID_PHASE_HIGH, 0xB8);
    if (err != ESP_OK) return err;
    err = write_u16(REG_WOI_SD0, 0x0F0D);
    if (err != ESP_OK) return err;
    err = write_u16(REG_INITIAL_PHASE_SD0, 0x0E0E);
    if (err != ESP_OK) return err;

    /* Long-mode 50 ms timing budget, from ST ULD. */
    err = write_u16(REG_RANGE_TIMEOUT_A, 0x00AD);
    if (err != ESP_OK) return err;
    err = write_u16(REG_RANGE_TIMEOUT_B, 0x00C6);
    if (err != ESP_OK) return err;

    uint16_t clock_pll = 0;
    err = read_u16(REG_OSC_CALIBRATE_VAL, &clock_pll);
    if (err != ESP_OK) return err;

    clock_pll &= 0x03FFU;
    if (clock_pll == 0) {
        ESP_LOGE(TAG, "OSC_CALIBRATE_VAL无效");
        return ESP_ERR_INVALID_RESPONSE;
    }

    const uint32_t intermeasurement_register =
        (uint32_t)((float)clock_pll * TOF_INTERMEASUREMENT_MS * 1.075f);
    err = write_u32(REG_INTERMEASUREMENT_PERIOD, intermeasurement_register);
    if (err != ESP_OK) return err;

    err = write_u8(REG_INTERRUPT_CLEAR, 0x01);
    if (err != ESP_OK) return err;
    err = write_u8(REG_MODE_START, 0x40);
    if (err != ESP_OK) return err;

    ESP_LOGI(
        TAG,
        "测距启动：软件I2C SCL=GPIO%d SDA=GPIO%d，7位地址0x%02X/8位写地址0x%02X，长距离模式",
        VL53L1X_SCL_GPIO,
        VL53L1X_SDA_GPIO,
        VL53L1X_I2C_ADDRESS_7BIT,
        VL53L1X_I2C_WRITE_ADDRESS_8BIT
    );
    return ESP_OK;
}

esp_err_t vl53l1x_init(void)
{
    s_online = false;
    s_distance_ema_initialized = false;
    s_distance_ema_mm = 0.0f;

    esp_err_t err = sw_i2c_gpio_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "软件I2C GPIO初始化失败：%s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(
        TAG,
        "软件I2C空闲电平：SCL(GPIO%d)=%d SDA(GPIO%d)=%d",
        VL53L1X_SCL_GPIO,
        gpio_get_level(VL53L1X_SCL_GPIO),
        VL53L1X_SDA_GPIO,
        gpio_get_level(VL53L1X_SDA_GPIO)
    );

    err = sw_i2c_bus_recover();
    if (err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "软件I2C总线恢复失败：SCL=%d SDA=%d",
            gpio_get_level(VL53L1X_SCL_GPIO),
            gpio_get_level(VL53L1X_SDA_GPIO)
        );
        return err;
    }

    /* Do not rely on ESP-IDF i2c_master_probe. Scan with the same byte-level
     * protocol used by the customer STM32 example. */
    scan_i2c_bus();

    err = address_ack_test(VL53L1X_I2C_ADDRESS_7BIT);
    if (err != ESP_OK) {
        ESP_LOGE(
            TAG,
            "客服协议地址测试失败：0x52未收到ACK（7位地址0x29），err=%s",
            esp_err_to_name(err)
        );
        return err;
    }

    ESP_LOGI(TAG, "0x52写地址收到ACK，开始读取启动状态和型号寄存器");

    err = sensor_init_sequence();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "VL53L1X初始化失败：%s", esp_err_to_name(err));
        return err;
    }

    s_online = true;
    return ESP_OK;
}

bool vl53l1x_is_online(void)
{
    return s_online;
}

esp_err_t vl53l1x_read(vl53l1x_sample_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->online = s_online;
    out->distance_filtered_mm = s_distance_ema_mm;
    out->range_status = 255;

    if (!s_online) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = wait_for_data_ready(TOF_READY_WAIT_MS);
    if (err != ESP_OK) {
        return err;
    }
    out->data_ready = true;

    uint8_t result[17] = {0};
    err = read_bytes(REG_RESULT_RANGE_STATUS, result, sizeof(result));
    if (err != ESP_OK) {
        return err;
    }

    const uint8_t raw_status = result[0] & 0x1FU;
    out->range_status =
        raw_status < sizeof(RANGE_STATUS_MAP)
        ? RANGE_STATUS_MAP[raw_status]
        : 255;

    out->ambient_kcps =
        (uint16_t)((((uint16_t)result[7] << 8) | result[8]) * 8U);
    out->spad_count = result[3];
    out->signal_per_spad_kcps =
        (uint16_t)((((uint16_t)result[15] << 8) | result[16]) * 8U);
    out->distance_raw_mm =
        ((uint16_t)result[13] << 8) | result[14];

    err = write_u8(REG_INTERRUPT_CLEAR, 0x01);
    if (err != ESP_OK) {
        return err;
    }

    out->valid =
        out->range_status == 0 &&
        out->distance_raw_mm >= TOF_DISTANCE_MIN_MM &&
        out->distance_raw_mm <= TOF_DISTANCE_MAX_MM;

    if (out->valid) {
        if (!s_distance_ema_initialized) {
            s_distance_ema_mm = (float)out->distance_raw_mm;
            s_distance_ema_initialized = true;
        } else {
            s_distance_ema_mm =
                TOF_EMA_ALPHA * (float)out->distance_raw_mm +
                (1.0f - TOF_EMA_ALPHA) * s_distance_ema_mm;
        }
    }

    out->distance_filtered_mm = s_distance_ema_mm;
    return ESP_OK;
}
