#include "device_registration.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "device_identity.h"
#include "esp_http_client.h"
#include "esp_log.h"
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#include "esp_crt_bundle.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "posture_model.h"
#include "sdkconfig.h"
#include "wifi_manager.h"

#define REGISTRATION_STACK_SIZE 6144
#define REGISTRATION_PRIORITY 2

static const char *TAG = "device_registration";

static esp_err_t register_once(void)
{
    char url[320];
    const int written = snprintf(url, sizeof(url), "%s/device/register", wifi_manager_backend_base_url());
    if (written < 0 || written >= (int)sizeof(url)) return ESP_ERR_INVALID_SIZE;

    char name[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    char secret[SPINEGUARD_DEVICE_SECRET_CAPACITY] = {0};
    char claim[SPINEGUARD_CLAIM_CODE_CAPACITY] = {0};
    device_identity_copy_name(name, sizeof(name));
    device_identity_copy_secret(secret, sizeof(secret));
    device_identity_copy_claim_code(claim, sizeof(claim));

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(root, "device_id", device_identity_id());
    cJSON_AddStringToObject(root, "device_name", name);
    cJSON_AddStringToObject(root, "claim_code", claim);
    cJSON_AddStringToObject(root, "firmware_version", CONFIG_SPINEGUARD_FIRMWARE_VERSION);
    cJSON_AddStringToObject(root, "model_version", POSTURE_MODEL_VERSION);
    char body[512];
    const bool printed = cJSON_PrintPreallocated(root, body, sizeof(body), false);
    cJSON_Delete(root);
    if (!printed) return ESP_ERR_INVALID_SIZE;

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 4000,
    };
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
    config.crt_bundle_attach = esp_crt_bundle_attach;
#endif
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) return ESP_ERR_NO_MEM;
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Device-ID", device_identity_id());
    esp_http_client_set_header(client, "X-Device-Token", secret);
    esp_http_client_set_post_field(client, body, strlen(body));

    const esp_err_t err = esp_http_client_perform(client);
    const int status = err == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    esp_http_client_cleanup(client);
    if (err == ESP_OK && status >= 200 && status < 300) {
        ESP_LOGI(TAG, "Device registration accepted, HTTP %d", status);
        return ESP_OK;
    }
    ESP_LOGD(TAG, "Device registration pending: err=%s HTTP %d", esp_err_to_name(err), status);
    return err == ESP_OK ? ESP_FAIL : err;
}

static void registration_task(void *arg)
{
    (void)arg;
    while (true) {
        if (wifi_manager_is_connected()) {
            (void)register_once();
        }
        vTaskDelay(pdMS_TO_TICKS(CONFIG_SPINEGUARD_REGISTRATION_RETRY_INTERVAL_MS));
    }
}

esp_err_t device_registration_start(void)
{
    const BaseType_t created = xTaskCreate(registration_task, "device_register", REGISTRATION_STACK_SIZE, NULL, REGISTRATION_PRIORITY, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
