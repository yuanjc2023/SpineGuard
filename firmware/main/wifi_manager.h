#ifndef SPINEGUARD_WIFI_MANAGER_H
#define SPINEGUARD_WIFI_MANAGER_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Wi-Fi configuration is stored in NVS. If credentials are absent or the
 * saved network cannot be reached, the device opens:
 *   SSID: SpineGuard-<MAC-derived device id>
 *   URL:  http://192.168.4.1
 */
esp_err_t wifi_manager_start(void);
bool wifi_manager_is_connected(void);
bool wifi_manager_is_provisioning(void);
const char *wifi_manager_backend_base_url(void);
/* Clears only Wi-Fi/backend NVS data; identity and reminder settings remain. */
esp_err_t wifi_manager_clear_saved_config(void);

/* Returns INT32_MIN when RSSI is unavailable. */
int32_t wifi_manager_get_rssi_dbm(void);

/* SNTP-backed Unix time helpers. */
bool wifi_manager_time_is_valid(void);
int64_t wifi_manager_unix_timestamp_ms(void);

#ifdef __cplusplus
}
#endif

#endif
