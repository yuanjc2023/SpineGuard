# 原始压力值与遥测协议 V2 修改说明

## 1. 修改目的

原有遥测数据中的 `pressure.left/right/front/back/center` 是经过传感器标定和归一化后的压力值，范围为 `0~1000`。为了支持传感器标定、硬件故障排查和算法复核，本次修改新增同一次采样对应的五个 ADC 原始压力值。

本次修改不会用原始值替代归一化值。两组数据会同时保存：

- `pressure`：归一化压力，范围 `0~1000`，继续用于坐姿识别、压力特征计算和前端图表。
- `raw_pressure`：归一化前的 ADC 原始值，范围 `0~4095`，用于标定、排查和数据分析。

## 2. 数据库修改

在 SQLite 数据库 `backend/spineguard.db` 的 `posture_records` 表中新增以下五列：

| 数据库字段 | 类型 | 是否允许为空 | 说明 |
| --- | --- | --- | --- |
| `raw_pressure_left` | integer | 是 | 左侧传感器 ADC 原始值 |
| `raw_pressure_right` | integer | 是 | 右侧传感器 ADC 原始值 |
| `raw_pressure_front` | integer | 是 | 前侧传感器 ADC 原始值 |
| `raw_pressure_back` | integer | 是 | 后侧传感器 ADC 原始值 |
| `raw_pressure_center` | integer | 是 | 中央传感器 ADC 原始值 |

数据库启动初始化逻辑会检查这五列是否存在。如果是旧版 SQLite 数据库，后端会通过只新增列的方式完成升级，不会删除表或清空已有记录。

升级前的历史记录没有保存 ADC 原始值，因此这些旧记录的五列为 `NULL`。查询接口会将其表示为：

```json
{
  "raw_pressure": null
}
```

新上传的遥测记录会完整保存五个原始值。

## 3. 遥测协议修改

设备遥测协议由 V1 升级为 V2：

```json
{
  "protocol_version": 2,
  "pressure": {
    "left": 520,
    "right": 510,
    "front": 430,
    "back": 620,
    "center": 760
  },
  "raw_pressure": {
    "left": 2148,
    "right": 2096,
    "front": 1761,
    "back": 2540,
    "center": 3112
  }
}
```

V2 中 `raw_pressure` 为必填对象，必须包含：

```text
left
right
front
back
center
```

每项必须是 `0~4095` 之间的整数。完整遥测格式以以下文件为准：

- `shared/schema.json`
- `shared/example.json`
- `docs/telemetry-contract.md`

上传接口不变：

```text
POST /api/v1/device/telemetry
Header: X-Device-Token: <device_token>
Content-Type: application/json
```

## 4. 后端实现

本次后端修改包括：

1. 新增 `RawPressure` 请求模型，校验五个 ADC 值的范围。
2. `Telemetry` 请求模型固定使用 `protocol_version=2`。
3. 接收遥测后，将五个原始值写入 `posture_records`。
4. 实时、历史和 WebSocket 遥测数据中返回 `raw_pressure`。
5. 管理员 CSV、Excel 和风险学生记录导出中增加五个原始压力列。
6. SQLite 启动时自动补充缺少的原始压力列。

新记录的查询响应示例：

```json
{
  "protocol_version": 2,
  "pressure": {
    "left": 520,
    "right": 510,
    "front": 430,
    "back": 620,
    "center": 760
  },
  "raw_pressure": {
    "left": 2148,
    "right": 2096,
    "front": 1761,
    "back": 2540,
    "center": 3112
  }
}
```

旧记录仍可正常查询，其 `protocol_version` 返回 `1`，`raw_pressure` 返回 `null`。

## 5. 固件修改

固件增加了 `raw_pressure_values_t` 结构体。读取五路 FSR ADC 后：

1. 原始 `raw[0..4]` 保存到 `raw_pressure`。
2. 归一化结果继续保存到 `pressure`。
3. HTTP 上传 JSON 同时携带两组数值。
4. 固件上报版本更新为 `0.3.0`。

固件真实上传使用 `recognition_source=rule`。后续调整 ADC 位宽或输入范围时，需要同时修改固件、后端校验和 `shared/schema.json`。

## 6. Web 与小程序修改

### Web 测试前端

Web 增加 V2 遥测 TypeScript 类型和 `raw_pressure` 模拟值。通过测试页面上传的数据仍明确标记：

```json
{
  "recognition_source": "mock"
}
```

模拟数据只能用于联调，不能当作真实传感器采样数据。

### 小程序

小程序实时页会解析接口响应中的 `raw_pressure`，并展示五个 ADC 原始值。查询到升级前的旧记录时显示 `--`，不会将缺失值误显示为 `0`。

## 7. 前端调用说明

前端和小程序不需要更改查询接口地址，只需要在读取实时或历史遥测时增加以下兼容处理：

```javascript
const rawPressure = telemetry.raw_pressure || null;

if (rawPressure) {
  console.log(rawPressure.left);
  console.log(rawPressure.right);
  console.log(rawPressure.front);
  console.log(rawPressure.back);
  console.log(rawPressure.center);
}
```

如果前端负责生成模拟遥测，请使用 V2 格式并同时满足：

```text
protocol_version = 2
raw_pressure 五个字段齐全
recognition_source = mock
```

归一化压力图、坐姿判断和已有统计继续读取 `pressure` 与 `pressure_features`。只有需要展示传感器 ADC、制作标定工具或导出原始数据时，才读取 `raw_pressure`。

## 8. 验证结果

本次修改完成后的验证结果：

- SQLite `posture_records` 已成功增加五个 `raw_pressure_*` 列。
- 原有 3536 条开发记录保留，未被删除或改写。
- 后端测试：`20 passed`。
- Web 验证：`npm run build` 成功。
- `shared/schema.json` 和 `shared/example.json` JSON 格式校验通过。
- 当前电脑未加载 ESP-IDF 命令环境，因此尚未执行 `idf.py build`；硬件同学应在配置好 ESP-IDF 的终端中完成固件编译验证。

## 9. 协作注意事项

本次修改后，旧版 V1 固件或只上传 `pressure` 的模拟程序将无法通过新的请求校验。硬件、Web 模拟器或其他设备数据发生器必须同步到 V2。

以后修改任何遥测字段时，应同时更新：

1. `shared/schema.json`
2. 后端请求模型和数据库模型
3. Web 类型与模拟数据
4. 小程序解析逻辑
5. 固件上传结构
6. 遥测协议文档和示例

