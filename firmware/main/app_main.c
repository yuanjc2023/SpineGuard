#include <stdio.h>
#include <string.h>

#include "esp_adc/adc_oneshot.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#define SAMPLE_COUNT 16
#define WIFI_CONNECTED_BIT BIT0

static const char *TAG = "spineguard";
static EventGroupHandle_t s_wifi_bits;

static int read_avg(adc_oneshot_unit_handle_t h, adc_channel_t ch)
{
    int sum = 0;
    for (int i = 0; i < SAMPLE_COUNT; i++) {
        int raw = 0;
        ESP_ERROR_CHECK(adc_oneshot_read(h, ch, &raw));
        sum += raw;
    }
    return sum / SAMPLE_COUNT;
}

static void wifi_event_handler(
    void *arg,
    esp_event_base_t base,
    int32_t event_id,
    void *event_data
)
{
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (
        base == WIFI_EVENT &&
        event_id == WIFI_EVENT_STA_DISCONNECTED
    ) {
        xEventGroupClearBits(s_wifi_bits, WIFI_CONNECTED_BIT);
        esp_wifi_connect();
    } else if (
        base == IP_EVENT &&
        event_id == IP_EVENT_STA_GOT_IP
    ) {
        xEventGroupSetBits(s_wifi_bits, WIFI_CONNECTED_BIT);
    }
}

static void wifi_start(void)
{
    if (strlen(CONFIG_SPINEGUARD_WIFI_SSID) == 0) {
        ESP_LOGW(TAG, "Wi-Fi SSID未配置，只输出串口JSON");
        return;
    }

    esp_err_t err = nvs_flash_init();
    if (
        err == ESP_ERR_NVS_NO_FREE_PAGES ||
        err == ESP_ERR_NVS_NEW_VERSION_FOUND
    ) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(err);
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));

    s_wifi_bits = xEventGroupCreate();

    ESP_ERROR_CHECK(
        esp_event_handler_register(
            WIFI_EVENT,
            ESP_EVENT_ANY_ID,
            wifi_event_handler,
            NULL
        )
    );
    ESP_ERROR_CHECK(
        esp_event_handler_register(
            IP_EVENT,
            IP_EVENT_STA_GOT_IP,
            wifi_event_handler,
            NULL
        )
    );

    wifi_config_t config = {0};
    snprintf(
        (char *)config.sta.ssid,
        sizeof(config.sta.ssid),
        "%s",
        CONFIG_SPINEGUARD_WIFI_SSID
    );
    snprintf(
        (char *)config.sta.password,
        sizeof(config.sta.password),
        "%s",
        CONFIG_SPINEGUARD_WIFI_PASSWORD
    );

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
    ESP_ERROR_CHECK(esp_wifi_start());
}

static int wifi_connected(void)
{
    return s_wifi_bits != NULL &&
        (xEventGroupGetBits(s_wifi_bits) & WIFI_CONNECTED_BIT);
}

static void upload_json(const char *json)
{
    if (!wifi_connected()) {
        return;
    }

    esp_http_client_config_t config = {
        .url = CONFIG_SPINEGUARD_BACKEND_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        return;
    }

    esp_http_client_set_header(
        client,
        "Content-Type",
        "application/json"
    );
    esp_http_client_set_header(
        client,
        "X-Device-Token",
        CONFIG_SPINEGUARD_DEVICE_TOKEN
    );
    esp_http_client_set_post_field(client, json, strlen(json));

    esp_err_t err = esp_http_client_perform(client);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "上传失败：%s", esp_err_to_name(err));
    }

    esp_http_client_cleanup(client);
}

void app_main(void)
{
    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t unit = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    adc_oneshot_chan_cfg_t cfg = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten = ADC_ATTEN_DB_12,
    };

    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit, &adc));
    ESP_ERROR_CHECK(
        adc_oneshot_config_channel(adc, ADC_CHANNEL_3, &cfg)
    ); /* GPIO4 */
    ESP_ERROR_CHECK(
        adc_oneshot_config_channel(adc, ADC_CHANNEL_4, &cfg)
    ); /* GPIO5 */

    wifi_start();

    unsigned long seq = 0;
    unsigned upload_ticks = 0;
    char json[768];

    while (1) {
        int left_raw = read_avg(adc, ADC_CHANNEL_3);
        int right_raw = read_avg(adc, ADC_CHANNEL_4);
        int left = (4095 - left_raw) * 1000 / 4095;
        int right = (4095 - right_raw) * 1000 / 4095;

        const char *posture = "normal";
        if (left + right < 80) {
            posture = "empty";
        } else if (left - right > 180) {
            posture = "left_lean";
        } else if (right - left > 180) {
            posture = "right_lean";
        }

        int warning =
            strcmp(posture, "empty") != 0 &&
            strcmp(posture, "normal") != 0;

        snprintf(
            json,
            sizeof(json),
            "{"
            "\"protocol_version\":1,"
            "\"device_id\":\"%s\","
            "\"session_id\":\"S-DEVICE-001\","
            "\"seq\":%lu,"
            "\"timestamp_ms\":%lld,"
            "\"posture\":\"%s\","
            "\"confidence\":0.90,"
            "\"pressure\":{"
                "\"left\":%d,"
                "\"right\":%d,"
                "\"front\":0,"
                "\"back\":0,"
                "\"center\":0"
            "},"
            "\"posture_duration_s\":0,"
            "\"sitting_duration_s\":0,"
            "\"vibration_enabled\":true,"
            "\"warning_active\":%s,"
            "\"recognition_source\":\"rule\","
            "\"model_version\":\"rule-v0.1\","
            "\"firmware_version\":\"0.1.0\""
            "}",
            CONFIG_SPINEGUARD_DEVICE_ID,
            ++seq,
            esp_timer_get_time() / 1000,
            posture,
            left,
            right,
            warning ? "true" : "false"
        );

        printf("%s\n", json);

        upload_ticks++;
        if (upload_ticks >= 25) {
            upload_ticks = 0;
            upload_json(json);
        }

        vTaskDelay(pdMS_TO_TICKS(200));
    }
}
