# 设备遥测协议

本文档定义 ESP32-S3、模拟设备、后端、Web 和小程序共同遵守的设备上传字段。机器可校验版本以 `shared/schema.json` 为准，示例以 `shared/example.json` 为准。

## 设计原则

- API JSON 字段统一使用 `snake_case`。
- 模拟数据必须标记 `recognition_source=mock`。
- 风险相关结果只能表述为坐姿行为风险提示或筛查参考，不作为医学诊断。
- 设备上传接口使用设备 Token；用户端接口使用 JWT。
- 新增或修改遥测字段时，必须同步更新 `shared/schema.json`、后端模型、Web 类型、小程序解析和固件结构。

## 上传入口

```text
POST /api/v1/device/telemetry
Header: X-Device-Token: <device_token>
Content-Type: application/json
```

后端收到数据后负责校验、落库、更新设备最新状态，并向 Web/小程序提供查询或实时推送能力。

## 字段定义

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `protocol_version` | integer | 是 | 协议版本，当前固定为 `1`。 |
| `device_id` | string | 是 | 设备编号，例如 `SG-0001`。 |
| `session_id` | string | 是 | 本次就坐或演示会话编号。 |
| `seq` | integer | 是 | 设备端递增序号，用于排查丢包或乱序。 |
| `timestamp_ms` | integer | 是 | 设备端时间戳，毫秒。 |
| `posture` | enum | 是 | 当前坐姿分类。 |
| `confidence` | number | 是 | 坐姿识别置信度，范围 `0~1`。 |
| `pressure` | object | 是 | 五点压力值，范围 `0~1000`。 |
| `pressure_features` | object | 是 | 由压力计算出的特征指数。 |
| `imu` | object | 是 | 姿态辅助数据；没有真实 IMU 时填 `0`。 |
| `posture_duration_s` | integer | 是 | 当前坐姿连续持续秒数。 |
| `sitting_duration_s` | integer | 是 | 本次连续就坐秒数。 |
| `vibration_enabled` | boolean | 是 | 设备是否允许震动提醒。 |
| `warning_active` | boolean | 是 | 当前是否处于提醒状态。 |
| `reminder_count` | integer | 是 | 本次会话累计提醒次数。 |
| `battery_level` | integer | 是 | 电量百分比，范围 `0~100`；无电池原型可填 `100`。 |
| `recognition_source` | enum | 是 | 识别来源：`mock`、`rule`、`neural_network`。 |
| `model_version` | string | 是 | 规则或模型版本。 |
| `firmware_version` | string | 是 | 固件版本。 |

## 枚举值

`posture` 只能使用以下值：

```text
empty
normal
left_lean
right_lean
front_lean
back_lean
unknown
```

前端和小程序负责把英文枚举映射为中文展示，例如 `left_lean` 显示为“左倾”。

`recognition_source` 只能使用以下值：

```text
mock
rule
neural_network
```

## 压力字段

`pressure` 表示五点压力采样归一化后的数值：

| 字段 | 说明 |
| --- | --- |
| `left` | 左侧压力 |
| `right` | 右侧压力 |
| `front` | 前侧压力 |
| `back` | 后侧压力 |
| `center` | 中央压力 |

范围统一为 `0~1000`。数值越大表示压力越大。

## 压力特征

`pressure_features` 用于后端统计、风险提示和图表展示。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `total_pressure` | integer | 五点压力总和。 |
| `left_right_diff` | integer | `left - right`，正数表示左侧更重。 |
| `front_back_diff` | integer | `front - back`，正数表示前侧更重。 |
| `center_x` | number | 压力中心横向偏移，范围建议 `-1~1`。 |
| `center_y` | number | 压力中心纵向偏移，范围建议 `-1~1`。 |
| `asymmetry_index` | number | 压力不对称指数，范围 `0~1`。 |

第一阶段允许由模拟设备或固件端计算。正式后端落库时可以重新计算一遍，用于校验设备端结果。

## IMU 字段

`imu` 为姿态辅助数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tilt_x` | number | 横向倾角，单位度。 |
| `tilt_y` | number | 前后倾角，单位度。 |
| `shake_level` | number | 身体晃动强度，建议归一化到 `0~1`。 |

没有接入 MPU6050/BMI270 时，三个字段统一填 `0`。

## 示例

完整示例见 `shared/example.json`。

