#include "device_identity.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "nvs.h"

#define IDENTITY_NAMESPACE "identity"
#define DEVICE_NAME_KEY "name"
#define DEVICE_SECRET_KEY "secret"
#define CLAIM_CODE_KEY "claim"

static const char *TAG = "device_identity";
static char s_device_id[SPINEGUARD_DEVICE_ID_CAPACITY] = "SG-UNKNOWN";
static char s_device_name[SPINEGUARD_DEVICE_NAME_CAPACITY] = "SpineGuard";
static char s_device_secret[SPINEGUARD_DEVICE_SECRET_CAPACITY] = {0};
static char s_claim_code[SPINEGUARD_CLAIM_CODE_CAPACITY] = {0};
static bool s_initialized;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;

static bool normalize_name(const char *input, char output[SPINEGUARD_DEVICE_NAME_CAPACITY])
{
    if (input == NULL || output == NULL) return false;
    const unsigned char *start = (const unsigned char *)input;
    while (*start != '\0' && isspace(*start)) ++start;
    const unsigned char *end = start + strlen((const char *)start);
    while (end > start && isspace(end[-1])) --end;
    const size_t length = (size_t)(end - start);
    if (length == 0 || length >= SPINEGUARD_DEVICE_NAME_CAPACITY) return false;
    for (size_t i = 0; i < length; ++i) {
        if (start[i] < 0x20 || start[i] == 0x7f) return false;
    }
    memcpy(output, start, length);
    output[length] = '\0';
    return true;
}

static void random_hex(char output[SPINEGUARD_DEVICE_SECRET_CAPACITY])
{
    static const char HEX[] = "0123456789abcdef";
    uint8_t bytes[32];
    esp_fill_random(bytes, sizeof(bytes));
    for (size_t i = 0; i < sizeof(bytes); ++i) {
        output[i * 2] = HEX[(bytes[i] >> 4) & 0x0f];
        output[i * 2 + 1] = HEX[bytes[i] & 0x0f];
    }
    output[64] = '\0';
}

static void random_claim_code(char output[SPINEGUARD_CLAIM_CODE_CAPACITY])
{
    uint32_t code = esp_random() % 1000000U;
    for (int index = 5; index >= 0; --index) {
        output[index] = (char)('0' + (code % 10U));
        code /= 10U;
    }
    output[6] = '\0';
}

static bool load_string(nvs_handle_t nvs, const char *key, char *buffer, size_t size)
{
    size_t required = size;
    return nvs_get_str(nvs, key, buffer, &required) == ESP_OK && buffer[0] != '\0';
}

static esp_err_t save_identity_values(
    const char *name,
    const char *secret,
    const char *claim
)
{
    nvs_handle_t nvs = 0;
    esp_err_t err = nvs_open(IDENTITY_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK && name != NULL) err = nvs_set_str(nvs, DEVICE_NAME_KEY, name);
    if (err == ESP_OK && secret != NULL) err = nvs_set_str(nvs, DEVICE_SECRET_KEY, secret);
    if (err == ESP_OK && claim != NULL) err = nvs_set_str(nvs, CLAIM_CODE_KEY, claim);
    if (err == ESP_OK) err = nvs_commit(nvs);
    if (nvs != 0) nvs_close(nvs);
    return err;
}

esp_err_t device_identity_init(void)
{
    if (s_initialized) return ESP_OK;

    uint8_t mac[6] = {0};
    const esp_err_t mac_err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (mac_err != ESP_OK) return mac_err;

    snprintf(s_device_id, sizeof(s_device_id), "SG-%02X%02X%02X", mac[3], mac[4], mac[5]);

    char default_name[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    snprintf(default_name, sizeof(default_name), "SpineGuard %02X%02X%02X", mac[3], mac[4], mac[5]);

    char loaded_name[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    char loaded_secret[SPINEGUARD_DEVICE_SECRET_CAPACITY] = {0};
    char loaded_claim[SPINEGUARD_CLAIM_CODE_CAPACITY] = {0};
    bool has_name = false;
    bool has_secret = false;
    bool has_claim = false;

    nvs_handle_t nvs = 0;
    const esp_err_t open_err = nvs_open(IDENTITY_NAMESPACE, NVS_READONLY, &nvs);
    if (open_err == ESP_OK) {
        has_name = load_string(nvs, DEVICE_NAME_KEY, loaded_name, sizeof(loaded_name)) &&
            device_identity_name_is_valid(loaded_name);
        has_secret = load_string(nvs, DEVICE_SECRET_KEY, loaded_secret, sizeof(loaded_secret)) &&
            strlen(loaded_secret) == 64;
        has_claim = load_string(nvs, CLAIM_CODE_KEY, loaded_claim, sizeof(loaded_claim)) &&
            strlen(loaded_claim) == 6;
        nvs_close(nvs);
    } else if (open_err != ESP_ERR_NVS_NOT_FOUND) {
        return open_err;
    }

    if (!has_secret) random_hex(loaded_secret);
    if (!has_claim) random_claim_code(loaded_claim);
    if (!has_name) snprintf(loaded_name, sizeof(loaded_name), "%s", default_name);

    if (!has_name || !has_secret || !has_claim) {
        const esp_err_t save_err = save_identity_values(loaded_name, loaded_secret, loaded_claim);
        if (save_err != ESP_OK) return save_err;
    }

    portENTER_CRITICAL(&s_lock);
    snprintf(s_device_name, sizeof(s_device_name), "%s", loaded_name);
    snprintf(s_device_secret, sizeof(s_device_secret), "%s", loaded_secret);
    snprintf(s_claim_code, sizeof(s_claim_code), "%s", loaded_claim);
    portEXIT_CRITICAL(&s_lock);

    s_initialized = true;
    ESP_LOGI(TAG, "Device identity: id=%s, name=%s, claim_code=%s", s_device_id, s_device_name, s_claim_code);
    return ESP_OK;
}

const char *device_identity_id(void) { return s_device_id; }

static void copy_locked(const char *source, char *buffer, size_t buffer_size)
{
    if (buffer == NULL || buffer_size == 0) return;
    portENTER_CRITICAL(&s_lock);
    snprintf(buffer, buffer_size, "%s", source);
    portEXIT_CRITICAL(&s_lock);
}

void device_identity_copy_name(char *buffer, size_t buffer_size) { copy_locked(s_device_name, buffer, buffer_size); }
void device_identity_copy_secret(char *buffer, size_t buffer_size) { copy_locked(s_device_secret, buffer, buffer_size); }
void device_identity_copy_claim_code(char *buffer, size_t buffer_size) { copy_locked(s_claim_code, buffer, buffer_size); }

bool device_identity_name_is_valid(const char *name)
{
    char normalized[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    return normalize_name(name, normalized);
}

esp_err_t device_identity_set_name(const char *name)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    char normalized[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    if (!normalize_name(name, normalized)) return ESP_ERR_INVALID_ARG;
    const esp_err_t err = save_identity_values(normalized, NULL, NULL);
    if (err != ESP_OK) return err;
    portENTER_CRITICAL(&s_lock);
    snprintf(s_device_name, sizeof(s_device_name), "%s", normalized);
    portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG, "Device name updated: %s", normalized);
    return ESP_OK;
}

esp_err_t device_identity_rotate_claim_code(void)
{
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    char claim[SPINEGUARD_CLAIM_CODE_CAPACITY] = {0};
    random_claim_code(claim);
    const esp_err_t err = save_identity_values(NULL, NULL, claim);
    if (err != ESP_OK) return err;
    portENTER_CRITICAL(&s_lock);
    snprintf(s_claim_code, sizeof(s_claim_code), "%s", claim);
    portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG, "Claim code rotated: %s", claim);
    return ESP_OK;
}
