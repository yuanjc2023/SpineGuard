#include "wifi_manager.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "cJSON.h"
#include "device_identity.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_NAMESPACE "wifi_cfg"
#define WIFI_SSID_KEY "ssid"
#define WIFI_PASSWORD_KEY "password"
#define BACKEND_URL_KEY "backend_url"
#define PROVISION_BODY_MAX 640
#define WIFI_SCAN_MAX_RESULTS 20
#define UNIX_TIME_VALID_AFTER 1700000000LL

static const char *TAG = "wifi_manager";
static EventGroupHandle_t s_wifi_bits;
static httpd_handle_t s_http_server;
static esp_netif_t *s_sta_netif;
static int s_retry_count;
static bool s_provisioning;
static bool s_has_credentials;
static bool s_sntp_started;
static char s_backend_base_url[192];

static const char SETUP_PAGE[] =
    "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>SpineGuard设备配置</title><style>"
    "body{font-family:Arial,'Microsoft YaHei',sans-serif;background:#f5f7fa;margin:0;padding:24px;}"
    ".card{max-width:560px;margin:0 auto;background:white;border-radius:16px;padding:24px;"
    "box-shadow:0 8px 30px rgba(0,0,0,.08)}h2{margin-top:0}label{display:block;margin-top:14px;"
    "font-weight:600}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;"
    "border-radius:9px;border:1px solid #ccd3dc;font-size:15px}button{border:0;background:#1769e0;"
    "color:white;font-weight:700;cursor:pointer}.secondary{background:#eef2f7;color:#253044}"
    ".danger{background:#c93434}.hint{color:#5f6b7a;font-size:13px;line-height:1.55}"
    "#status,#result{white-space:pre-wrap;background:#f7f9fc;padding:10px;border-radius:8px;"
    "font-size:13px;min-height:20px}</style></head><body><div class='card'>"
    "<h2>SpineGuard设备与网络配置</h2>"
    "<p class='hint'>设备编号由硬件自动生成且保持不变；设备名称可以自由修改。绑定设备时使用页面显示的6位绑定码。</p>"
    "<div id='status'>正在读取设备状态……</div>"
    "<label for='deviceName'>设备名称</label>"
    "<input id='deviceName' maxlength='32' autocomplete='off' placeholder='例如 我的学习椅'>"
    "<p class='hint'>支持中文、英文和数字，UTF-8编码后最长63字节。</p>"
    "<label for='ssid'>Wi-Fi名称（SSID）</label>"
    "<input id='ssid' list='networkList' maxlength='32' autocomplete='off' placeholder='选择或输入SSID'>"
    "<datalist id='networkList'></datalist>"
    "<button class='secondary' onclick='scanNetworks()'>扫描附近Wi-Fi</button>"
    "<label for='password'>Wi-Fi密码</label>"
    "<input id='password' type='password' maxlength='64' placeholder='开放网络可留空'>"
    "<label for='backend'>后端基础地址</label>"
    "<input id='backend' maxlength='191' placeholder='例如 http://192.168.1.10:8000/api/v1'>"
    "<p class='hint'>请填写到/api/v1这一层，不要填写/device/telemetry；末尾斜杠会自动移除。</p>"
    "<button onclick='saveConfig()'>保存并重启</button>"
    "<button class='danger' onclick='resetConfig()'>清除已保存网络并重启</button>"
    "<p class='hint'>清除网络不会删除设备名称和设备唯一编号。</p>"
    "<pre id='result'></pre></div><script>"
    "const $=id=>document.getElementById(id);"
    "async function loadStatus(){try{const r=await fetch('/api/status');const d=await r.json();"
    "$('deviceName').value=d.device_name||'';$('backend').value=d.backend_url||'';"
    "$('status').textContent='设备名称：'+(d.device_name||'未命名')+'\\n设备编号：'+d.device_id+'\\n联网：'+"
    "(d.connected?'已连接':'未连接')+'\\n当前网络：'+(d.station_ssid||'无')+'\\nIP：'+"
    "(d.ip||'无')+'\\n信号：'+(d.rssi_dbm===null?'不可用':d.rssi_dbm+' dBm')+'\\n绑定码：'+d.claim_code;}catch(e){"
    "$('status').textContent='读取状态失败：'+e;}}"
    "async function scanNetworks(){$('result').textContent='正在扫描……';try{const r=await fetch('/api/networks');"
    "const d=await r.json();const list=$('networkList');list.innerHTML='';(d.items||[]).forEach(x=>{"
    "const o=document.createElement('option');o.value=x.ssid;o.label=x.ssid+' ('+x.rssi_dbm+' dBm)';"
    "list.appendChild(o);});$('result').textContent='发现 '+(d.items||[]).length+' 个网络';}catch(e){"
    "$('result').textContent='扫描失败：'+e;}}"
    "async function saveConfig(){const name=$('deviceName').value.trim();"
    "if(!name){$('result').textContent='设备名称不能为空';return;}"
    "if(new TextEncoder().encode(name).length>63){$('result').textContent='设备名称过长，请缩短';return;}"
    "const body={device_name:name,ssid:$('ssid').value.trim(),password:$('password').value,"
    "backend_url:$('backend').value.trim()};$('result').textContent='正在保存……';try{const r=await fetch('/api/provision',"
    "{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});"
    "$('result').textContent=await r.text();}catch(e){$('result').textContent='保存失败：'+e;}}"
    "async function resetConfig(){if(!confirm('确认清除Wi-Fi和后端配置？设备名称会保留。'))return;try{"
    "const r=await fetch('/api/reset',{method:'POST'});$('result').textContent=await r.text();}catch(e){"
    "$('result').textContent='操作失败：'+e;}}"
    "loadStatus();scanNetworks();</script></body></html>";

static esp_err_t ensure_nvs(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

static bool load_string(nvs_handle_t nvs, const char *key, char *buffer, size_t size)
{
    size_t required = size;
    const esp_err_t err = nvs_get_str(nvs, key, buffer, &required);
    return err == ESP_OK && buffer[0] != '\0';
}

static bool normalize_backend_url(const char *input, char *output, size_t output_size)
{
    if (input == NULL || output == NULL || output_size == 0) {
        return false;
    }
    if (strncmp(input, "http://", 7) != 0 && strncmp(input, "https://", 8) != 0) {
        return false;
    }
    if (strpbrk(input, "\"'\\\r\n\t ") != NULL) {
        return false;
    }
    const size_t length = strlen(input);
    if (length == 0 || length >= output_size) {
        return false;
    }
    snprintf(output, output_size, "%s", input);
    size_t end = strlen(output);
    while (end > 0 && output[end - 1] == '/') {
        output[--end] = '\0';
    }
    return end > 8;
}

static void load_backend_url(nvs_handle_t nvs)
{
    char stored[sizeof(s_backend_base_url)] = {0};
    const char *candidate = CONFIG_SPINEGUARD_BACKEND_BASE_URL;
    if (load_string(nvs, BACKEND_URL_KEY, stored, sizeof(stored))) {
        candidate = stored;
    }
    if (!normalize_backend_url(candidate, s_backend_base_url, sizeof(s_backend_base_url))) {
        snprintf(s_backend_base_url, sizeof(s_backend_base_url), "%s", "http://192.168.1.100:8000/api/v1");
    }
}

static void start_sntp(void)
{
    if (s_sntp_started) {
        return;
    }
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_SPINEGUARD_SNTP_SERVER);
    const esp_err_t err = esp_netif_sntp_init(&config);
    if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) {
        s_sntp_started = true;
        ESP_LOGI(TAG, "SNTP started: %s", CONFIG_SPINEGUARD_SNTP_SERVER);
    } else {
        ESP_LOGW(TAG, "SNTP start failed: %s", esp_err_to_name(err));
    }
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(1200));
    esp_restart();
}

static esp_err_t page_handler(httpd_req_t *request)
{
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    return httpd_resp_send(request, SETUP_PAGE, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t redirect_handler(httpd_req_t *request)
{
    httpd_resp_set_status(request, "302 Found");
    httpd_resp_set_hdr(request, "Location", "http://192.168.4.1/");
    return httpd_resp_send(request, NULL, 0);
}

static esp_err_t provision_handler(httpd_req_t *request)
{
    if (request->content_len <= 0 || request->content_len >= PROVISION_BODY_MAX) {
        httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "invalid body size");
        return ESP_FAIL;
    }

    char body[PROVISION_BODY_MAX];
    int received = 0;
    while (received < request->content_len) {
        const int chunk = httpd_req_recv(request, body + received, request->content_len - received);
        if (chunk <= 0) {
            httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "read failed");
            return ESP_FAIL;
        }
        received += chunk;
    }
    body[received] = '\0';

    cJSON *root = cJSON_Parse(body);
    const cJSON *device_name = root ? cJSON_GetObjectItemCaseSensitive(root, "device_name") : NULL;
    const cJSON *ssid = root ? cJSON_GetObjectItemCaseSensitive(root, "ssid") : NULL;
    const cJSON *password = root ? cJSON_GetObjectItemCaseSensitive(root, "password") : NULL;
    const cJSON *backend = root ? cJSON_GetObjectItemCaseSensitive(root, "backend_url") : NULL;

    char normalized_backend[sizeof(s_backend_base_url)] = {0};
    const bool backend_present = cJSON_IsString(backend) && backend->valuestring[0] != '\0';
    const bool invalid_device_name =
        !cJSON_IsString(device_name) ||
        !device_identity_name_is_valid(device_name->valuestring);
    const bool invalid_credentials =
        !cJSON_IsString(ssid) || ssid->valuestring[0] == '\0' || strlen(ssid->valuestring) > 32 ||
        !cJSON_IsString(password) || strlen(password->valuestring) > 64;
    const bool invalid_backend = backend_present &&
        !normalize_backend_url(backend->valuestring, normalized_backend, sizeof(normalized_backend));

    if (invalid_device_name || invalid_credentials || invalid_backend) {
        cJSON_Delete(root);
        httpd_resp_send_err(
            request,
            HTTPD_400_BAD_REQUEST,
            invalid_device_name ? "invalid device_name" :
            (invalid_backend ? "invalid backend_url" : "invalid ssid/password")
        );
        return ESP_FAIL;
    }

    nvs_handle_t nvs = 0;
    esp_err_t err = nvs_open(WIFI_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK) {
        err = nvs_set_str(nvs, WIFI_SSID_KEY, ssid->valuestring);
    }
    if (err == ESP_OK) {
        err = nvs_set_str(nvs, WIFI_PASSWORD_KEY, password->valuestring);
    }
    if (err == ESP_OK && backend_present) {
        err = nvs_set_str(nvs, BACKEND_URL_KEY, normalized_backend);
    }
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    if (nvs != 0) {
        nvs_close(nvs);
    }
    if (err == ESP_OK) {
        err = device_identity_set_name(device_name->valuestring);
    }
    cJSON_Delete(root);

    if (err != ESP_OK) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "NVS save failed");
        return ESP_FAIL;
    }

    httpd_resp_set_type(request, "application/json; charset=utf-8");
    httpd_resp_sendstr(request, "{\"ok\":true,\"message\":\"配置已保存，设备正在重启\"}");
    xTaskCreate(restart_task, "wifi_restart", 2048, NULL, 3, NULL);
    return ESP_OK;
}

static esp_err_t reset_handler(httpd_req_t *request)
{
    const esp_err_t err = wifi_manager_clear_saved_config();
    if (err != ESP_OK) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "NVS reset failed");
        return ESP_FAIL;
    }
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    httpd_resp_sendstr(request, "{\"ok\":true,\"message\":\"配置已清除，设备正在重启\"}");
    xTaskCreate(restart_task, "wifi_restart", 2048, NULL, 3, NULL);
    return ESP_OK;
}

static esp_err_t status_handler(httpd_req_t *request)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }

    char device_name[SPINEGUARD_DEVICE_NAME_CAPACITY] = {0};
    device_identity_copy_name(device_name, sizeof(device_name));
    cJSON_AddStringToObject(root, "device_id", device_identity_id());
    char claim_code[SPINEGUARD_CLAIM_CODE_CAPACITY] = {0};
    device_identity_copy_claim_code(claim_code, sizeof(claim_code));
    cJSON_AddStringToObject(root, "device_name", device_name);
    cJSON_AddStringToObject(root, "claim_code", claim_code);
    cJSON_AddBoolToObject(root, "connected", wifi_manager_is_connected());
    cJSON_AddBoolToObject(root, "provisioning", s_provisioning);
    cJSON_AddStringToObject(root, "backend_url", s_backend_base_url);

    wifi_ap_record_t ap = {0};
    if (wifi_manager_is_connected() && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        cJSON_AddStringToObject(root, "station_ssid", (const char *)ap.ssid);
        cJSON_AddNumberToObject(root, "rssi_dbm", ap.rssi);
    } else {
        cJSON_AddStringToObject(root, "station_ssid", "");
        cJSON_AddNullToObject(root, "rssi_dbm");
    }

    esp_netif_ip_info_t ip_info = {0};
    char ip[16] = {0};
    if (s_sta_netif != NULL && esp_netif_get_ip_info(s_sta_netif, &ip_info) == ESP_OK &&
        ip_info.ip.addr != 0) {
        snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ip_info.ip));
    }
    cJSON_AddStringToObject(root, "ip", ip);

    char *response = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (response == NULL) {
        return ESP_ERR_NO_MEM;
    }
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    const esp_err_t err = httpd_resp_sendstr(request, response);
    cJSON_free(response);
    return err;
}

static esp_err_t networks_handler(httpd_req_t *request)
{
    wifi_scan_config_t scan = {
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    };
    const esp_err_t scan_err = esp_wifi_scan_start(&scan, true);
    if (scan_err != ESP_OK) {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(scan_err));
        return ESP_FAIL;
    }

    uint16_t count = WIFI_SCAN_MAX_RESULTS;
    wifi_ap_record_t records[WIFI_SCAN_MAX_RESULTS] = {0};
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_scan_get_ap_records(&count, records));

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }
    cJSON *items = cJSON_AddArrayToObject(root, "items");
    if (items == NULL) {
        cJSON_Delete(root);
        return ESP_ERR_NO_MEM;
    }

    for (uint16_t i = 0; i < count; ++i) {
        bool duplicate = false;
        for (uint16_t j = 0; j < i; ++j) {
            if (strcmp((const char *)records[i].ssid, (const char *)records[j].ssid) == 0) {
                duplicate = true;
                break;
            }
        }
        if (duplicate || records[i].ssid[0] == '\0') {
            continue;
        }
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", (const char *)records[i].ssid);
        cJSON_AddNumberToObject(item, "rssi_dbm", records[i].rssi);
        cJSON_AddBoolToObject(item, "secured", records[i].authmode != WIFI_AUTH_OPEN);
        cJSON_AddItemToArray(items, item);
    }

    char *response = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (response == NULL) {
        return ESP_ERR_NO_MEM;
    }
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    const esp_err_t err = httpd_resp_sendstr(request, response);
    cJSON_free(response);
    return err;
}

static void start_http_server(void)
{
    if (s_http_server != NULL) {
        return;
    }
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 10;
    if (httpd_start(&s_http_server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Unable to start provisioning HTTP server");
        s_http_server = NULL;
        return;
    }

    const httpd_uri_t handlers[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_handler},
        {.uri = "/api/provision", .method = HTTP_POST, .handler = provision_handler},
        {.uri = "/api/reset", .method = HTTP_POST, .handler = reset_handler},
        {.uri = "/api/status", .method = HTTP_GET, .handler = status_handler},
        {.uri = "/api/networks", .method = HTTP_GET, .handler = networks_handler},
        {.uri = "/generate_204", .method = HTTP_GET, .handler = redirect_handler},
        {.uri = "/hotspot-detect.html", .method = HTTP_GET, .handler = redirect_handler},
        {.uri = "/ncsi.txt", .method = HTTP_GET, .handler = redirect_handler},
    };
    for (size_t i = 0; i < sizeof(handlers) / sizeof(handlers[0]); ++i) {
        ESP_ERROR_CHECK(httpd_register_uri_handler(s_http_server, &handlers[i]));
    }
}

static void stop_provisioning_ap(void)
{
    if (!s_provisioning) {
        return;
    }

    if (s_http_server != NULL) {
        httpd_stop(s_http_server);
        s_http_server = NULL;
    }

    const esp_err_t mode_err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (mode_err != ESP_OK) {
        ESP_LOGW(TAG, "Unable to stop setup AP: %s", esp_err_to_name(mode_err));
        return;
    }
    s_provisioning = false;
    ESP_LOGI(TAG, "Provisioning AP stopped after station connection");
}


static void build_provisioning_ssid(uint8_t ssid[32], uint8_t *ssid_len)
{
    static const char prefix[] = "SpineGuard-";
    const char *device_id = device_identity_id();
    const size_t prefix_length = sizeof(prefix) - 1;
    size_t id_length = strlen(device_id);
    if (id_length > sizeof(((wifi_config_t *)0)->ap.ssid) - prefix_length) {
        id_length = sizeof(((wifi_config_t *)0)->ap.ssid) - prefix_length;
    }

    memcpy(ssid, prefix, prefix_length);
    memcpy(ssid + prefix_length, device_id, id_length);
    *ssid_len = (uint8_t)(prefix_length + id_length);
}

static void start_provisioning_ap(void)
{
    if (s_provisioning) {
        return;
    }

    wifi_config_t ap = {0};
    build_provisioning_ssid(ap.ap.ssid, &ap.ap.ssid_len);
    snprintf((char *)ap.ap.password, sizeof(ap.ap.password), "%s", CONFIG_SPINEGUARD_SETUP_AP_PASSWORD);
    ap.ap.channel = 1;
    ap.ap.max_connection = 4;
    ap.ap.authmode = strlen(CONFIG_SPINEGUARD_SETUP_AP_PASSWORD) >= 8
        ? WIFI_AUTH_WPA2_PSK
        : WIFI_AUTH_OPEN;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    s_provisioning = true;
    start_http_server();
    ESP_LOGW(
        TAG,
        "Provisioning AP: %.*s, open http://192.168.4.1",
        ap.ap.ssid_len,
        (char *)ap.ap.ssid
    );
}

static void wifi_event_handler(
    void *arg,
    esp_event_base_t event_base,
    int32_t event_id,
    void *event_data
)
{
    (void)arg;

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        if (s_has_credentials) {
            esp_wifi_connect();
        }
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_bits, WIFI_CONNECTED_BIT);
        const wifi_event_sta_disconnected_t *event = event_data;
        ESP_LOGW(TAG, "Wi-Fi disconnected, reason=%d", event ? event->reason : -1);
        if (s_has_credentials && s_retry_count < CONFIG_SPINEGUARD_WIFI_MAX_RETRY) {
            s_retry_count++;
            esp_wifi_connect();
        } else {
            ESP_LOGW(TAG, "Saved Wi-Fi unavailable; entering setup mode");
            start_provisioning_ap();
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        s_retry_count = 0;
        xEventGroupSetBits(s_wifi_bits, WIFI_CONNECTED_BIT);
        const ip_event_got_ip_t *event = event_data;
        ESP_LOGI(TAG, "Wi-Fi connected, IP=" IPSTR, IP2STR(&event->ip_info.ip));
        start_sntp();
        stop_provisioning_ap();
    }
}

esp_err_t wifi_manager_start(void)
{
    ESP_RETURN_ON_ERROR(ensure_nvs(), TAG, "NVS init failed");
    ESP_RETURN_ON_ERROR(device_identity_init(), TAG, "device identity init failed");
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif init failed");

    esp_err_t event_err = esp_event_loop_create_default();
    if (event_err != ESP_OK && event_err != ESP_ERR_INVALID_STATE) {
        return event_err;
    }

    s_sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();
    if (s_sta_netif == NULL) {
        return ESP_ERR_NO_MEM;
    }
    char hostname[64];
    snprintf(hostname, sizeof(hostname), "spineguard-%s", device_identity_id());
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_netif_set_hostname(s_sta_netif, hostname));

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "Wi-Fi init failed");

    s_wifi_bits = xEventGroupCreate();
    if (s_wifi_bits == NULL) {
        return ESP_ERR_NO_MEM;
    }
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    nvs_handle_t nvs = 0;
    ESP_RETURN_ON_ERROR(nvs_open(WIFI_NAMESPACE, NVS_READWRITE, &nvs), TAG, "NVS open failed");
    char ssid[33] = {0};
    char password[65] = {0};
    s_has_credentials = load_string(nvs, WIFI_SSID_KEY, ssid, sizeof(ssid));
    load_string(nvs, WIFI_PASSWORD_KEY, password, sizeof(password));
    load_backend_url(nvs);
    nvs_close(nvs);

    if (s_has_credentials) {
        wifi_config_t station = {0};

        /*
         * wifi_sta_config_t uses fixed-width byte arrays: SSID is 32 bytes and
         * password is 64 bytes. A maximum-length value is valid even though it
         * has no trailing NUL inside the destination array. Using snprintf()
         * therefore produces a false-positive -Wformat-truncation error when
         * warnings are treated as errors. The source buffers were loaded with
         * one extra byte for NUL and were already size-validated, so copy the
         * exact payload bytes into the zero-initialized ESP-IDF structure.
         */
        const size_t ssid_length = strlen(ssid);
        const size_t password_length = strlen(password);
        memcpy(station.sta.ssid, ssid, ssid_length);
        memcpy(station.sta.password, password, password_length);

        station.sta.threshold.authmode = WIFI_AUTH_OPEN;
        station.sta.pmf_cfg.capable = true;
        station.sta.pmf_cfg.required = false;
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &station));
    } else {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    }

    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "Wi-Fi start failed");
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));
    if (!s_has_credentials) {
        start_provisioning_ap();
    }
    return ESP_OK;
}

esp_err_t wifi_manager_clear_saved_config(void)
{
    nvs_handle_t nvs = 0;
    esp_err_t err = nvs_open(WIFI_NAMESPACE, NVS_READWRITE, &nvs);
    if (err == ESP_OK) err = nvs_erase_all(nvs);
    if (err == ESP_OK) err = nvs_commit(nvs);
    if (nvs != 0) nvs_close(nvs);
    return err;
}

bool wifi_manager_is_connected(void)
{
    return s_wifi_bits != NULL &&
        (xEventGroupGetBits(s_wifi_bits) & WIFI_CONNECTED_BIT) != 0;
}

bool wifi_manager_is_provisioning(void)
{
    return s_provisioning;
}

const char *wifi_manager_backend_base_url(void)
{
    return s_backend_base_url;
}

int32_t wifi_manager_get_rssi_dbm(void)
{
    wifi_ap_record_t ap = {0};
    if (!wifi_manager_is_connected() || esp_wifi_sta_get_ap_info(&ap) != ESP_OK) {
        return INT32_MIN;
    }
    return ap.rssi;
}

bool wifi_manager_time_is_valid(void)
{
    return (int64_t)time(NULL) >= UNIX_TIME_VALID_AFTER;
}

int64_t wifi_manager_unix_timestamp_ms(void)
{
    struct timeval now = {0};
    gettimeofday(&now, NULL);
    return (int64_t)now.tv_sec * 1000LL + now.tv_usec / 1000LL;
}
