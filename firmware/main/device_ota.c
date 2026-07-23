#include "device_ota.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "device_commands.h"
#include "device_identity.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#include "esp_crt_bundle.h"
#endif

#define OTA_TASK_STACK_SIZE 10240
#define OTA_TASK_PRIORITY 5
#define OTA_READ_BUFFER_SIZE 4096

static const char *TAG = "device_ota";
static device_command_t s_command;
static bool s_running;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

static int hex_value(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    c = (char)tolower((unsigned char)c);
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static bool parse_sha256(const char *hex, uint8_t output[32])
{
    if (hex == NULL || strlen(hex) != 64) return false;
    for (size_t i = 0; i < 32; ++i) {
        const int high = hex_value(hex[i * 2]);
        const int low = hex_value(hex[i * 2 + 1]);
        if (high < 0 || low < 0) return false;
        output[i] = (uint8_t)((high << 4) | low);
    }
    return true;
}

static void finish_command(bool success, const char *error)
{
    ESP_ERROR_CHECK_WITHOUT_ABORT(device_commands_complete(s_command.id, success, error));
    portENTER_CRITICAL(&s_lock);
    s_running = false;
    portEXIT_CRITICAL(&s_lock);
}

static void ota_task(void *arg)
{
    (void)arg;
    uint8_t expected_sha[32];
    if (!parse_sha256(s_command.firmware_sha256, expected_sha)) {
        finish_command(false, "invalid_sha256");
        vTaskDelete(NULL);
    }

    esp_http_client_config_t http_config = {
        .url = s_command.firmware_url,
        .timeout_ms = 10000,
        .keep_alive_enable = true,
    };
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
    http_config.crt_bundle_attach = esp_crt_bundle_attach;
#endif
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (client == NULL) {
        finish_command(false, "http_client_init_failed");
        vTaskDelete(NULL);
    }

    char secret[SPINEGUARD_DEVICE_SECRET_CAPACITY] = {0};
    device_identity_copy_secret(secret, sizeof(secret));
    esp_http_client_set_header(client, "X-Device-ID", device_identity_id());
    esp_http_client_set_header(client, "X-Device-Token", secret);

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        finish_command(false, "firmware_download_open_failed");
        vTaskDelete(NULL);
    }
    const int64_t content_length = esp_http_client_fetch_headers(client);
    const int status = esp_http_client_get_status_code(client);
    if (status < 200 || status >= 300) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        finish_command(false, "firmware_http_status");
        vTaskDelete(NULL);
    }

    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (partition == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        finish_command(false, "no_ota_partition");
        vTaskDelete(NULL);
    }

    esp_ota_handle_t ota_handle = 0;
    err = esp_ota_begin(partition, OTA_SIZE_UNKNOWN, &ota_handle);
    if (err != ESP_OK) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        finish_command(false, "ota_begin_failed");
        vTaskDelete(NULL);
    }

    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    if (mbedtls_sha256_starts(&sha, 0) != 0) {
        esp_ota_abort(ota_handle);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        finish_command(false, "sha_init_failed");
        vTaskDelete(NULL);
    }

    uint8_t buffer[OTA_READ_BUFFER_SIZE];
    int64_t total_read = 0;
    bool failed = false;
    const char *failure = "firmware_download_failed";
    while (true) {
        const int read = esp_http_client_read(client, (char *)buffer, sizeof(buffer));
        if (read < 0) {
            failed = true;
            break;
        }
        if (read == 0) {
            if (esp_http_client_is_complete_data_received(client)) break;
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (esp_ota_write(ota_handle, buffer, (size_t)read) != ESP_OK) {
            failed = true;
            failure = "ota_write_failed";
            break;
        }
        if (mbedtls_sha256_update(&sha, buffer, (size_t)read) != 0) {
            failed = true;
            failure = "sha_update_failed";
            break;
        }
        total_read += read;
        if (content_length > 0) {
            const uint8_t progress = (uint8_t)((total_read * 95) / content_length);
            device_commands_set_progress(s_command.id, progress > 95 ? 95 : progress);
        }
    }

    uint8_t actual_sha[32] = {0};
    if (!failed && mbedtls_sha256_finish(&sha, actual_sha) != 0) {
        failed = true;
        failure = "sha_finish_failed";
    }
    mbedtls_sha256_free(&sha);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (failed || memcmp(actual_sha, expected_sha, sizeof(actual_sha)) != 0) {
        esp_ota_abort(ota_handle);
        finish_command(false, failed ? failure : "sha256_mismatch");
        vTaskDelete(NULL);
    }

    err = esp_ota_end(ota_handle);
    if (err != ESP_OK) {
        finish_command(false, "ota_image_validation_failed");
        vTaskDelete(NULL);
    }
    err = esp_ota_set_boot_partition(partition);
    if (err != ESP_OK) {
        finish_command(false, "set_boot_partition_failed");
        vTaskDelete(NULL);
    }

    device_commands_set_progress(s_command.id, 100);
    finish_command(true, "");
    ESP_LOGW(TAG, "OTA prepared for version %s, restarting", s_command.target_version);
    vTaskDelay(pdMS_TO_TICKS(2500));
    esp_restart();
}

esp_err_t device_ota_start(const device_command_t *command)
{
    if (command == NULL || command->type != DEVICE_COMMAND_OTA_UPDATE) return ESP_ERR_INVALID_ARG;
    bool already_running;
    portENTER_CRITICAL(&s_lock);
    already_running = s_running;
    if (!already_running) {
        s_command = *command;
        s_running = true;
    }
    portEXIT_CRITICAL(&s_lock);
    if (already_running) return ESP_ERR_INVALID_STATE;
    const BaseType_t created = xTaskCreate(ota_task, "device_ota", OTA_TASK_STACK_SIZE, NULL, OTA_TASK_PRIORITY, NULL);
    if (created != pdPASS) {
        portENTER_CRITICAL(&s_lock);
        s_running = false;
        portEXIT_CRITICAL(&s_lock);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
