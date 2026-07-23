# 新硬件功能后端适配说明

## 1. 修改背景

新版 ESP32-S3 固件新增了三项核心能力：

1. VL53L1X 靠背距离采集。
2. ESP32-S3 板端 LightGBM 坐姿识别模型。
3. 左、前、右、后四区定向振动提醒硬件。

固件同时增加了设备独立身份、设备登记、提醒配置轮询、传感器健康诊断和远程命令能力。后端已按 `firmware/` 中的实际 Telemetry V2 和请求路径完成适配。

这次修改保留原有账号、学生、设备绑定、统计、报告、游戏和通知逻辑。新增字段只扩展原来的遥测响应，普通前端不使用时可以直接忽略。

## 2. 端到端数据流

```text
五区 FSR + VL53L1X
→ ESP32-S3 采样与 20 帧窗口
→ 38 维特征
→ LightGBM 坐姿分类
→ 本地异常计时与定向振动
→ 每约 2 秒上传 Telemetry V2
→ FastAPI 校验、落库和实时推送
→ Web/小程序读取坐姿、靠背距离和提醒状态
```

后端仍通过以下接口接收遥测：

```text
POST /api/v1/device/telemetry
```

新版真实设备必须同时携带：

```text
X-Device-ID: <device_id>
X-Device-Token: <per_device_secret>
```

## 3. 靠背距离适配

### 3.1 上传结构

固件上传：

```json
{
  "backrest": {
    "online": true,
    "data_ready": true,
    "valid": true,
    "distance_mm": 88,
    "range_status": 0
  }
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `online` | VL53L1X 是否成功初始化并在线 |
| `data_ready` | 本周期是否取得新测距结果 |
| `valid` | 当前滤波距离是否有效 |
| `distance_mm` | 滤波后的靠背距离，单位毫米；无效时为 `null` |
| `range_status` | VL53L1X 测距状态码 |

### 3.2 数据库存储

`posture_records` 新增：

```text
backrest_online
backrest_data_ready
backrest_valid
backrest_distance_mm
backrest_range_status
```

这些字段允许为 `NULL`，所以升级前的历史记录可以继续使用。后端没有给旧记录伪造靠背距离。

### 3.3 前端读取

前端不需要新增专用接口，可以使用：

```text
GET /api/v1/students/{student_id}/latest
GET /api/v1/students/{student_id}/history?from=&to=&limit=
WS  /api/v1/ws/students/{student_id}?token=<access_token>
```

响应中直接包含：

```json
{
  "backrest": {
    "online": true,
    "data_ready": true,
    "valid": true,
    "distance_mm": 88,
    "range_status": 0
  }
}
```

推荐显示逻辑：

```typescript
const distanceText =
  telemetry.backrest?.online &&
  telemetry.backrest?.valid &&
  telemetry.backrest.distance_mm !== null
    ? `${(telemetry.backrest.distance_mm / 10).toFixed(1)} cm`
    : "--";
```

只有 `online=true`、`valid=true` 且 `distance_mm` 不为 `null` 时才应展示距离。旧记录的 `backrest` 为 `null`。

## 4. LightGBM 坐姿模型适配

### 4.1 模型信息

当前硬件模型：

```text
recognition_source=lightgbm
model_version=spineguard_lightgbm_fsr_tof_v2
```

后端 `recognition_source` 现在支持：

```text
rule
lightgbm
neural_network
mock
```

模拟数据仍必须使用 `recognition_source=mock`，不得伪装成真实模型结果。

### 4.2 后端处理

后端直接保存固件给出的稳定姿态、置信度、识别来源和模型版本：

```text
posture
confidence
recognition_source
model_version
```

现有坐姿枚举保持不变：

```text
empty
normal
left_lean
right_lean
front_lean
back_lean
unknown
```

因此已有每日统计、周统计、风险提示、报告和游戏状态机不需要更换姿态名称，也不需要区分规则模型与 LightGBM 才能继续工作。

### 4.3 兼容调整

新版固件没有接入 IMU，因此 Telemetry 可以省略旧 `imu` 对象。后端对省略的 IMU 数据以兼容值保存，但不会把它解释为真实 IMU 采样。

`pressure_features.total_pressure` 在新版固件中是五路标定曲线换算后的等效载荷总量，不是真实人体重量。后端校验上限从 5000 调整为 7500，前端不得将其标注为体重。

## 5. 振动提醒硬件适配

### 5.1 遥测状态

后端接收并保存：

| 字段 | 说明 |
| --- | --- |
| `vibration_enabled` | 用户设置的振动总开关 |
| `vibration_effective_enabled` | 考虑免打扰模式后的实际允许状态 |
| `warning_active` | 异常姿态是否达到提醒触发阶段 |
| `reminder_due` | 当前是否到达提醒时刻 |
| `reminder_suppressed` | 提醒是否因关闭或免打扰被抑制 |
| `vibration_active` | 电机当前是否正在振动 |
| `vibration_position` | `left/front/right/back/null` |
| `reminder_count` | 当前会话累计提醒次数 |
| `reminder_cooldown_remaining_s` | 距离下一次允许提醒的剩余秒数 |

`reminder_config` 还会回传设备实际应用的模式、触发时间、振动持续时间、冷却和强度。

### 5.2 数据库存储

`posture_records` 新增：

```text
vibration_effective_enabled
reminder_due
reminder_suppressed
vibration_active
vibration_position
reminder_cooldown_remaining_s
applied_config_version
reminder_config_json
```

管理员 CSV、Excel 和风险学生记录导出中也增加了靠背距离、是否振动和振动位置等字段。

### 5.3 远程提醒配置

用户侧接口：

```text
GET /api/v1/devices/{device_id}/config
PUT /api/v1/devices/{device_id}/config
Authorization: Bearer <access_token>
```

家长只能配置自己关联学生当前绑定的设备；管理员可以配置全部设备。

修改示例：

```json
{
  "device_name": "我的学习椅",
  "enabled": true,
  "mode": "study",
  "trigger_duration_s": 600,
  "vibration_duration_s": 10,
  "cooldown_s": 900,
  "intensity_percent": 40
}
```

约束范围：

| 参数 | 范围 |
| --- | --- |
| `mode` | `normal/study/do_not_disturb` |
| `trigger_duration_s` | 5～3600 秒 |
| `vibration_duration_s` | 1～120 秒 |
| `cooldown_s` | 30～7200 秒 |
| `intensity_percent` | 1～100 |

每次修改会递增 `config_version`。固件每 5 秒轮询配置，只有版本更高时才应用。前端应等待后续 Telemetry 中：

```text
applied_config_version == config_version
```

再显示“设备已同步”，不能仅凭 PUT 请求成功判断设备已经应用。

## 6. 设备健康状态

新版 Telemetry 的 `sensor_status` 包含：

- 五路 FSR 是否正常、基线是否有效。
- ToF 是否在线、测距是否有效。
- 电机控制模块是否就绪、自检是否完成、供电是否验证。

后端将完整对象保存为 JSON，并在设备状态和最新遥测中返回。该数据建议只用于管理员设备管理或硬件调试，不需要出现在普通家长主页。

当前设备使用充电宝但无法测量剩余电量，因此：

```json
{
  "battery_level": null,
  "power_source": "power_bank"
}
```

前端必须将 `battery_level=null` 显示为 `--` 或“未接入”，不能显示成 `0%`。

## 7. 设备登记与独立鉴权

### 7.1 设备登记

固件每 60 秒幂等调用：

```text
POST /api/v1/device/register
X-Device-ID: <device_id>
X-Device-Token: <64位设备密钥>
```

请求体：

```json
{
  "device_id": "SG-A8D738",
  "device_name": "SpineGuard A8D738",
  "claim_code": "123456",
  "firmware_version": "0.5.0-device-management",
  "model_version": "spineguard_lightgbm_fsr_tof_v2"
}
```

后端只保存设备密钥和六位绑定码的 SHA-256 哈希，不保存明文。设备完成新版登记后，遥测和配置轮询必须使用其独立密钥；旧模拟设备仍可使用开发环境全局 Token。

### 7.2 设备绑定

新固件登记后，调用原绑定接口时会校验六位 `bind_code`：

```text
POST /api/v1/devices/bind
```

小程序通过 SoftAP 首次配网时，推荐改用支持“等待设备上线后自动绑定”的接口：

```text
POST /api/v1/devices/pair
GET  /api/v1/devices/pairings/{pairing_id}
```

完整时序、请求响应和前端调用步骤见 `backend/SOFTAP_DEVICE_PAIRING_GUIDE.md`。Wi-Fi SSID 和密码只提交给硬件本地 `192.168.4.1`，不进入后端数据库。

```json
{
  "device_id": "SG-A8D738",
  "student_id": "STU-DEMO-001",
  "bind_code": "123456"
}
```

绑定码不正确时返回 400。旧数据库中尚未登记、没有绑定码哈希的设备继续兼容原有绑定方式。

## 8. 远程命令闭环

管理员接口：

```text
POST /api/v1/devices/{device_id}/commands
GET  /api/v1/devices/{device_id}/commands
```

支持：

```text
calibrate_empty
restart
enter_provisioning
factory_reset
rotate_claim_code
ota_update
```

普通命令示例：

```json
{
  "type": "calibrate_empty"
}
```

OTA 命令必须同时提供：

```json
{
  "type": "ota_update",
  "target_version": "0.6.0",
  "firmware_url": "https://example.com/firmware/spineguard-0.6.0.bin",
  "firmware_sha256": "64位十六进制SHA-256"
}
```

命令保存到新增的 `device_commands` 表。固件从配置轮询接口取得一个待执行命令，再通过 Telemetry 的 `command_status` 回传：

```text
idle
queued
running
success
failed
```

后端据此更新命令进度、错误信息和完成时间。同一设备同一时间只允许一个活动命令。

## 9. 数据库升级

后端启动时会为 SQLite 无损补充新列和 `device_commands` 表，不会删除已有数据。实际开发数据库升级时：

```text
posture_records: 6811 → 6811
devices: 3 → 3
```

已有遥测记录和设备均已保留。旧记录新增字段为 `NULL`。

当前自动补列逻辑仅用于 SQLite 开发数据库。以后迁移到已有 MySQL 数据库时，应使用 Alembic 编写正式迁移脚本。

## 10. 兼容性说明

- 原有实时、历史、统计、风险、报告、通知和游戏接口地址不变。
- 前端不展示硬件调试字段时，可以忽略新增字段。
- 靠背距离可以直接从原有 latest/history/WebSocket 数据读取。
- 原始 ADC 仍保留在后端和导出中，但普通前端不需要显示。
- 新固件可以省略 `imu`。
- 新固件 `battery_level` 可以为 `null`。
- 模拟设备脚本已经升级到 Telemetry V2，并继续标记 `recognition_source=mock`。

## 11. 验证结果

- 使用 `firmware/docs/telemetry_v2_example.json` 完成设备登记、配置、命令和遥测闭环测试。
- LightGBM 来源、靠背距离、振动位置、传感器健康和 `battery_level=null` 均通过验证。
- 后端测试：`21 passed`。
- Web TypeScript/Vite 构建成功。
- 共享示例和固件示例均可被后端 Telemetry 模型解析。
- 当前电脑未加载 ESP-IDF 环境，因此未执行 `idf.py build`；本次后端适配没有修改固件源码。

## 12. 相关文件

```text
backend/app/schemas.py                         新遥测和设备管理请求模型
backend/app/models.py                          数据库字段与 device_commands 表
backend/app/services/telemetry.py              新硬件字段落库、查询和命令回执
backend/app/services/device_management.py      设备鉴权、权限和配置响应
backend/app/routes/device_management.py        登记、配置和命令接口
backend/app/routes/telemetry.py                 逐设备密钥遥测鉴权
shared/schema.json                              统一 Telemetry V2 Schema
shared/example.json                             新硬件完整遥测示例
docs/telemetry-contract.md                      遥测字段说明
docs/implemented-api.md                         当前接口说明
```
