# SpineGuard ESP32-S3硬件固件

## 1.项目简介

SpineGuard是面向青少年坐姿监测与脊柱健康管理的智能坐垫硬件固件。本工程运行在ESP32-S3-DevKitC-1-N32R16V上，完成五区压力采集、靠背距离采集、板端LightGBM坐姿识别、四区定向振动提醒、Wi-Fi配网、设备身份管理、Telemetry V2上传、远程配置、远程命令和双分区OTA升级。

当前固件版本：

```text
0.5.0-device-management
```

板端模型版本：

```text
spineguard_lightgbm_fsr_tof_v2
```

开发环境：

```text
ESP-IDF v5.3.1
Target: esp32s3
Flash: 32MB Octal Flash
PSRAM: 16MB
串口波特率: 115200
```

## 2.当前完成状态

### 2.1已进入硬件工程的功能

- 五路FSR406B采集与32次ADC均值；
- 100ms采样周期和EMA滤波；
- 五路独立空载基线、灵敏度标定和蠕变补偿；
- 五区受力比例、压力中心、左右差、前后差和不对称度计算；
- VL53L1X靠背距离采集；
- 20帧窗口、10帧步长的LightGBM五分类推理；
- 三次连续预测确认稳定姿态；
- 左、前、右、后四路定向振动；
- LEDC 20kHz PWM振动强度控制；
- 常规、学习、免打扰三种提醒模式；
- 提醒触发时间、振动时长、冷却时间和强度远程配置；
- MAC自动生成稳定设备编号；
- 用户自定义设备名称；
- 每台设备独立`device_secret`和6位`claim_code`；
- SoftAP网页配网；
- 设备登记、Telemetry上传和远程配置轮询；
- `config_version/applied_config_version`配置执行确认；
- 远程空载校准、重启、重新配网、恢复出厂、更新绑定码；
- 双OTA分区、固件SHA-256校验和Bootloader回滚；
- FSR、ToF和电机控制状态诊断。

### 2.2已经由实物日志验证的部分

- 固件成功编译、烧录和启动；
- 32MB Octal Flash以OPI DTR模式运行；
- OTA分区表被Bootloader正确识别；
- 设备编号`SG-A8D738`、默认名称和绑定码成功生成；
- 配网热点与`http://192.168.4.1/`正常启动；
- PWM电机控制模块正常初始化；
- VL53L1X在地址`0x29`被识别，型号寄存器读取成功；
- 五路FSR完成空载基线采集；
- LightGBM模型进入运行流程。

### 2.3仍需完成的最终验收

- `buildfix2`重新编译、烧录，确认factory分区启动时输出`OTA confirmation skipped`；
- 五种姿态真人实测；
- 四个电机方向、强度和长时间供电稳定性实测；
- 后端三个设备接口的真实HTTP联调；
- 网页端和小程序配置、绑定、校准、命令状态的端到端联调；
- 至少完成一次真实OTA升级和回滚测试；
- 整机封装后的基线、识别率和供电稳定性复测。

## 3.硬件组成与接线

### 3.1主要器件

|器件|数量|用途|
|---|---:|---|
|ESP32-S3-DevKitC-1-N32R16V|1|主控、Wi-Fi、板端推理|
|FSR406B|5|坐垫五区压力采集|
|1kΩ电阻|5|FSR分压下拉电阻|
|VL53L1X|1|靠背距离采集|
|1027振动电机|4|左、前、右、后定向提醒|
|DRV8833|2|四路电机驱动|
|5V电源或充电宝|1|ESP32和电机支路供电|

### 3.2GPIO映射

|区域或功能|传感器编号|ESP32-S3 GPIO|
|---|---|---:|
|左侧FSR|S5|GPIO4|
|右侧FSR|S4|GPIO5|
|前侧FSR|S3|GPIO6|
|后侧FSR|S2|GPIO7|
|中心FSR|S1|GPIO8|
|VL53L1X SCL|-|GPIO10|
|VL53L1X SDA|-|GPIO11|
|左侧电机|-|GPIO15|
|前侧电机|-|GPIO16|
|右侧电机|-|GPIO17|
|后侧电机|-|GPIO18|

代码中的固定数组顺序为：

```text
left, right, front, back, center
```

### 3.3FSR分压电路

每一路FSR均使用：

```text
ESP32 3.3V
    │
  FSR406B
    │
ADC采样节点 ── ESP32 ADC GPIO
    │
   1kΩ
    │
   GND
```

在该接法下：

```text
压力增大→FSR阻值减小→ADC电压增大→ADC值增大
```

固件采用：

```text
adc_delta=max(filtered_adc-baseline_adc,0)
```

不得将FSR分压上端改接5V，否则可能使ESP32 ADC输入超过3.3V安全范围。

### 3.4VL53L1X接线

```text
VIN  → ESP32 3V3
GND  → ESP32 GND
SCL  → GPIO10
SDA  → GPIO11
XSHUT/INT暂不连接
```

当前使用软件I²C，7位地址为`0x29`。

### 3.5电机与DRV8833

四个控制GPIO分别连接两个DRV8833的四路输入。当前模块`STBY`接3.3V，`VM`连接独立5V电机电源。

必须满足：

```text
ESP32 GND、DRV8833 GND、电机电源GND共地
```

正式结构建议将同一充电宝5V分为：

```text
5V支路1→ESP32 USB/5V输入
5V支路2→DRV8833 VM
```

不要让四个电机的工作电流全部经过ESP32开发板5V引脚。

## 4.工程目录

```text
firmware/
├─CMakeLists.txt
├─sdkconfig.defaults
├─partitions.csv
├─README.md
├─FRONTEND_BACKEND_REQUIREMENTS.md
├─docs/
│  └─telemetry_v2_example.json
├─main/
│  ├─app_main.c
│  ├─fsr_pipeline.c/.h
│  ├─vl53l1x_driver.c/.h
│  ├─posture_model.c/.h
│  ├─posture_inference.c/.h
│  ├─posture_alert.c/.h
│  ├─motor_control.c/.h
│  ├─wifi_manager.c/.h
│  ├─device_identity.c/.h
│  ├─device_registration.c/.h
│  ├─device_config.c/.h
│  ├─device_commands.c/.h
│  ├─device_health.c/.h
│  ├─device_ota.c/.h
│  └─telemetry.c/.h
└─tools/
```

模块职责：

|模块|职责|
|---|---|
|`app_main.c`|初始化、10Hz主循环、串口输出、命令执行|
|`fsr_pipeline`|基线修正、蠕变补偿、独立标定、五区比例|
|`vl53l1x_driver`|VL53L1X初始化和测距|
|`posture_model`|转换后的LightGBM C模型|
|`posture_inference`|20帧窗口、38维特征和模型调用|
|`posture_alert`|稳定姿态、异常计时、冷却和提醒触发|
|`motor_control`|四路LEDC PWM电机控制|
|`wifi_manager`|SoftAP配网、Wi-Fi重连、SNTP|
|`device_identity`|设备编号、名称、密钥和绑定码|
|`device_registration`|设备自动登记|
|`device_config`|远程配置轮询、校验、NVS保存|
|`device_commands`|远程命令去重和状态管理|
|`device_health`|FSR、ToF和电机控制状态诊断|
|`device_ota`|固件下载、SHA-256验证和OTA切换|
|`telemetry`|Telemetry V2生成与HTTP上传|

## 5.采样与数据处理

### 5.1采样参数

```text
五路ADC平均次数: 32
主采样周期: 100ms
采样频率: 10Hz
EMA系数: 0.25
```

### 5.2空载基线

开机后必须保持坐垫无人、无重物。固件流程为：

```text
等待2s
→30轮预热
→100轮正式基线采样
→等待300ms
→20轮验证
→稳定则采用
→不稳定最多重试一次
```

远程`calibrate_empty`命令也使用该流程，并在检测到明显载荷时返回失败。

### 5.3压力数据的含义

`raw_adc`是ADC原始值，主要用于调试。

`pressure.left/right/front/back/center`是五区标定比例，单位为千分比：

```text
280表示28.0%
```

当`ratio_valid=true`时，五区数据总和约为1000。

`total_pressure`来自五路独立标定曲线换算出的等效载荷总量。它用于传感器差异校正和模型特征，不能当作人体真实重量或医学压力值展示。

### 5.4坐姿识别

模型类别：

```text
normal
left_lean
right_lean
front_lean
back_lean
```

规则状态：

```text
empty
unknown
```

模型输入条件：

- 已检测到有人就坐；
- 就坐预热至少5s；
- 五区比例有效；
- VL53L1X在线、数据有效且`range_status=0`；
- 靠背距离在40～2000mm；
- 连续有效帧间隔不超过250ms。

推理参数：

```text
窗口长度: 20帧，约2s
步长: 10帧，约1s
特征数量: 38
稳定切换: 连续3次有效预测
最低置信度: 0.50
无效结果宽限: 3s
```

## 6.振动提醒

### 6.1姿态与振动方向

|异常坐姿|振动位置|
|---|---|
|`left_lean`|左侧电机|
|`right_lean`|右侧电机|
|`front_lean`|前侧电机|
|`back_lean`|后侧电机|
|`normal/empty/unknown`|不振动|

### 6.2默认配置

```text
模式: normal
振动总开关: 开
异常触发时间: 300s
振动持续时间: 30s
重复提醒冷却: 600s
PWM强度: 70%
PWM频率: 20kHz
```

可配置范围：

|字段|范围|
|---|---:|
|`trigger_duration_s`|5～3600s|
|`vibration_duration_s`|1～120s|
|`cooldown_s`|30～7200s|
|`intensity_percent`|1～100%|
|当前硬件实际最大强度|70%|

当前Kconfig将实际PWM上限设为70%。后端下发更大值时，ESP32会限制到70%，Telemetry返回实际应用值。

### 6.3模式

- `normal`：切换到该模式时先采用300s、30s、600s、70%的默认值，随后再应用同一配置中的显式参数；
- `study`：切换到该模式时先采用600s、10s、900s、40%的默认值，随后再应用同一配置中的显式参数；
- `do_not_disturb`：保留现有时间和强度参数，但禁止电机输出，传感器采集、识别和上传继续运行。

## 7.设备身份

### 7.1设备编号

设备编号根据Wi-Fi Station MAC最后3字节生成：

```text
MAC: e8:f6:0a:a8:d7:38
device_id: SG-A8D738
```

`device_id`是稳定硬件身份，用于：

- 后端设备主键；
- 设备绑定；
-HTTP鉴权；
- Telemetry归属；
- 历史记录查询；
- 远程配置和命令路由。

用户不能修改`device_id`。

### 7.2设备名称

`device_name`是可修改的显示名称，例如：

```text
我的学习椅
宿舍智能坐垫
初三一班01号坐垫
```

名称保存在NVS中，UTF-8编码后最长63字节。修改名称不会改变设备绑定和历史数据关系。

### 7.3设备凭证

首次启动时生成：

```text
device_secret: 64位十六进制随机密钥
claim_code: 6位数字绑定码
```

HTTP设备请求头：

```http
X-Device-ID: SG-A8D738
X-Device-Token: <device_secret>
```

`device_secret`不得出现在普通用户页面、日志和API响应中。

`claim_code`只用于首次绑定，可通过`rotate_claim_code`命令更新。

## 8.Wi-Fi配网

### 8.1首次配网

设备没有可用Wi-Fi配置时创建热点：

```text
SSID: SpineGuard-<device_id>
示例: SpineGuard-SG-A8D738
默认密码: spineguard
地址: http://192.168.4.1/
```

配网页面可设置：

- 设备名称；
- 2.4GHz Wi-Fi SSID；
- Wi-Fi密码；
- 后端基础地址。

后端地址必须填写到：

```text
http://电脑局域网IP:8000/api/v1
```

不能填写：

```text
http://127.0.0.1:8000/api/v1
```

也不能填写完整Telemetry接口。

### 8.2配网页面本地接口

|方法|路径|用途|
|---|---|---|
|GET|`/`|配网页面|
|GET|`/api/status`|设备编号、名称、绑定码、联网状态|
|GET|`/api/networks`|扫描附近Wi-Fi|
|POST|`/api/provision`|保存名称、Wi-Fi和后端地址|
|POST|`/api/reset`|清除Wi-Fi和后端配置并重启|

### 8.3重连逻辑

- 保存Wi-Fi后，设备以Station模式连接；
-连接成功后启动SNTP并关闭配网热点；
-连接失败时最多重试`CONFIG_SPINEGUARD_WIFI_MAX_RETRY`次，默认10次；
-仍失败则重新开放配网热点；
-断网不影响本地采集、识别和振动提醒。

## 9.与后端的交互

后端基础地址示例：

```text
http://192.168.1.10:8000/api/v1
```

固件自动拼接以下接口：

|周期|方法|接口|用途|
|---:|---|---|---|
|60s|POST|`/device/register`|设备幂等登记|
|2s|POST|`/device/telemetry`|上传Telemetry V2|
|5s|GET|`/device/config/{device_id}`|读取配置和待执行命令|

所有设备接口均携带：

```http
X-Device-ID: <device_id>
X-Device-Token: <device_secret>
```

Telemetry只有在以下条件同时满足时上传：

```text
Wi-Fi已连接
SNTP时间有效
已产生最新传感器快照
```

后端具体补充要求见：

```text
FRONTEND_BACKEND_REQUIREMENTS.md
```

## 10.Telemetry V2

完整示例：

```text
docs/telemetry_v2_example.json
```

### 10.1核心字段

|字段|含义|
|---|---|
|`protocol_version`|协议版本，当前为2|
|`device_id`|稳定硬件编号|
|`device_name`|用户显示名称|
|`session_id`|本次运行会话编号|
|`seq`|本会话上传序号|
|`timestamp_ms`|SNTP同步后的Unix毫秒时间|
|`occupied`|是否有人就坐|
|`ratio_valid`|五区比例是否有效|
|`posture`|稳定坐姿|
|`confidence`|稳定坐姿置信度|
|`recognition_source`|`lightgbm`或`rule`|
|`model_version`|模型版本|

### 10.2压力字段

|字段|含义|
|---|---|
|`pressure`|五区千分比，前端除以10显示百分比|
|`raw_pressure`|五路原始ADC，仅调试和管理页面使用|
|`pressure_features.total_pressure`|等效载荷总量，不是真实体重|
|`left_right_diff`|左区比例减右区比例|
|`front_back_diff`|前区比例减后区比例|
|`center_x`|左右压力中心，约为-1～1|
|`center_y`|前后压力中心，约为-1～1|
|`asymmetry_index`|综合不对称度，0～1|

### 10.3靠背、提醒和健康字段

- `backrest`：ToF在线、有效性、距离和测距状态；
- `posture_duration_s`：当前稳定姿态持续时间；
- `sitting_duration_s`：本次连续就坐时间；
- `applied_config_version`：设备已应用的配置版本；
- `vibration_enabled`：用户振动总开关；
- `vibration_effective_enabled`：考虑免打扰后的实际允许状态；
- `warning_active`：异常姿态是否达到触发时长；
- `reminder_due`：是否已到提醒时刻；
- `reminder_suppressed`：提醒是否被关闭或免打扰抑制；
- `vibration_active`：当前是否正在振动；
- `vibration_position`：`left/front/right/back/null`；
- `reminder_count`：本次运行累计提醒次数；
- `sensor_status`：五路FSR、ToF和电机控制状态；
- `command_status`：最近命令的执行状态；
- `firmware_version`：固件版本。

### 10.4电量字段

当前使用普通充电宝供电，无法从USB 5V准确读取剩余电量，因此：

```json
{
  "battery_level": null,
  "power_source": "power_bank"
}
```

前端不得把`battery_level=null`显示为0%。

## 11.远程配置

设备每5s读取：

```http
GET /api/v1/device/config/{device_id}
```

支持平铺结构或外层`data`结构。推荐响应：

```json
{
  "config_version": 12,
  "device_name": "我的学习椅",
  "reminder": {
    "enabled": true,
    "mode": "study",
    "trigger_duration_s": 600,
    "vibration_duration_s": 10,
    "cooldown_s": 900,
    "intensity_percent": 40
  },
  "command": null
}
```

应用规则：

- 无`config_version`时，设备按兼容模式尝试应用；
- 有版本时，仅应用大于本地`applied_config_version`的配置；
-配置合法且NVS保存成功后才更新`applied_config_version`；
-前端必须等待Telemetry确认版本一致，不能仅凭后端保存成功显示“设备已同步”。

## 12.远程命令

支持的命令：

|命令|作用|关键结果|
|---|---|---|
|`calibrate_empty`|重新采集空载基线|有人时返回`seat_not_empty`|
|`restart`|设备重启|状态成功后约2.5s重启|
|`enter_provisioning`|清除Wi-Fi和后端地址|保留设备身份和提醒配置|
|`factory_reset`|擦除全部NVS|名称、密钥、绑定码和Wi-Fi全部重建|
|`rotate_claim_code`|生成新绑定码|设备编号和密钥不变|
|`ota_update`|下载并安装固件|需URL、版本和SHA-256|

普通命令：

```json
{
  "id": "cmd-20260723-001",
  "type": "calibrate_empty"
}
```

OTA命令：

```json
{
  "id": "cmd-ota-001",
  "type": "ota_update",
  "target_version": "0.6.0",
  "firmware_url": "https://example.com/firmware/spineguard-0.6.0.bin",
  "firmware_sha256": "64位十六进制SHA-256"
}
```

命令要求：

- `id`必须全局唯一；
-长度为1～63个可打印ASCII字符；
-同一时间只执行一个命令；
-ESP32会拒绝已完成、待执行或执行中的重复ID；
-最终状态保存在NVS，重启后仍可回传最近一次终态。

状态值：

```text
idle
queued
running
success
failed
```

## 13.设备健康状态

FSR状态码：

```text
unknown
ok
baseline_invalid
baseline_drift
stuck_low
stuck_high
no_change
out_of_calibration
```

`motor.control_ready=true`只表示LEDC控制模块已初始化。

`motor.self_test_completed=true`只表示上电自检流程执行完毕。

```text
motor.power_verified=false
```

不是电机故障，而是当前硬件没有电流检测，ESP32无法确认5V电机支路是否实际供电。

## 14.NVS数据

|命名空间|主要内容|
|---|---|
|`wifi_cfg`|SSID、密码、后端地址|
|`identity`|设备名称、设备密钥、绑定码|
|`device_cfg`|配置版本、模式、振动参数|
|`commands`|最近完成命令ID和终态|

操作影响：

|操作|Wi-Fi|名称|密钥|绑定码|提醒配置|
|---|---|---|---|---|---|
|配网页面“清除网络”|清除|保留|保留|保留|保留|
|`enter_provisioning`|清除|保留|保留|保留|保留|
|`factory_reset`|清除|清除|重新生成|重新生成|恢复默认|
|`erase-flash`|清除|清除|重新生成|重新生成|恢复默认|

## 15.Flash分区

当前32MB Flash分区：

|名称|类型|偏移|大小|用途|
|---|---|---:|---:|---|
|`nvs`|data/nvs|`0x9000`|24KB|配置和身份|
|`otadata`|data/ota|`0xF000`|8KB|OTA启动状态|
|`phy_init`|data/phy|`0x11000`|4KB|射频初始化|
|`factory`|app/factory|`0x20000`|4MB|USB烧录主固件|
|`ota_0`|app/ota_0|`0x420000`|4MB|OTA分区A|
|`ota_1`|app/ota_1|`0x820000`|4MB|OTA分区B|
|`storage`|data/spiffs|`0xC20000`|8MB|预留存储|

当前`storage`尚未挂载和写入。

## 16.构建、烧录和监视

### 16.1首次切换到当前分区表

```powershell
cd D:\competition\SpineGuard\firmware

Remove-Item sdkconfig -Force -ErrorAction SilentlyContinue
Remove-Item build -Recurse -Force -ErrorAction SilentlyContinue

idf.py set-target esp32s3
idf.py build
idf.py -p COM4 erase-flash
idf.py -p COM4 flash monitor
```

### 16.2普通代码更新

```powershell
cd D:\competition\SpineGuard\firmware

idf.py fullclean
idf.py build
idf.py -p COM4 flash monitor
```

普通更新不需要执行`erase-flash`，否则会清除Wi-Fi、名称、密钥、绑定码和远程配置。

### 16.3退出串口监视

```text
Ctrl+]
```

## 17.正常启动日志检查

应看到：

```text
SPI Flash Size : 32MB
flash io: opi_dtr
Device identity: id=SG-xxxxxx
Provisioning AP: SpineGuard-SG-xxxxxx
PWM motor control ready
发现I2C设备：7位地址=0x29
VL53L1X型号寄存器0x010F=0xEACC
FSR baseline L=... R=... F=... B=... C=...
Model=spineguard_lightgbm_fsr_tof_v2
```

`buildfix2`从factory分区启动时应看到：

```text
Running from factory partition; OTA confirmation skipped
```

不应再看到：

```text
Running firmware is factory
Unable to confirm OTA image
```

## 18.串口数据

### 18.1`HEADER3/DATA3`

用于传感器调试和CSV采集，包含：

- 五路原始ADC；
- EMA值；
- 基线增量；
- 蠕变修正；
- 等效载荷；
- 五区比例；
- ToF原始和滤波距离；
- 测距状态。

### 18.2`PRED4`

用于查看模型和提醒状态，包含：

- 推理编号；
- 模型原始姿态；
- 置信度；
- 稳定姿态；
- 稳定持续时间；
- 振动是否允许；
- 是否达到警告；
- 是否正在振动；
- 累计提醒次数；
- 五类概率。

## 19.测试清单

### 19.1FSR

- 空载启动时五路基线稳定；
-空载`filtered≈baseline`；
-空载`delta≈0`、`occupied=0`；
-逐路按压时对应通道`delta`明显增加；
-松开后恢复；
-五区位置未接反；
-没有持续`stuck_low/stuck_high/no_change`。

### 19.2VL53L1X

- 识别地址`0x29`；
-型号寄存器为`0xEACC`；
-距离随靠背前后移动变化；
-正常测距时`range_status=0`；
-无遮挡和超量程时不会输出伪造有效值。

### 19.3模型

分别测试：

```text
normal
left_lean
right_lean
front_lean
back_lean
```

记录稳定姿态、置信度和误判情况。完成真人数据验收前，不能只根据模型成功加载判定识别功能已经完全验证。

### 19.4电机

- 上电自检顺序为左、前、右、后；
-四个位置均能振动；
-PWM强度变化可感知；
-关闭振动时正在工作的电机立即停止；
-持续振动不会导致ESP32复位；
-振动时FSR和ToF数据无明显异常。

### 19.5网络和后端

-配网后获得局域网IP；
-SNTP时间有效；
-设备登记返回2xx；
-Telemetry返回2xx；
-配置轮询返回2xx；
-网页改名后设备应用新版本；
-关闭振动后Telemetry确认；
-校准命令经历`queued→running→success/failed`；
-设备离线时前端正确显示，不把旧数据当实时数据。

### 19.6OTA

-从factory下载到`ota_0`；
-SHA-256匹配；
-重启后从`ota_0`运行并确认有效；
-下一次升级写入`ota_1`；
-模拟无效固件时不切换；
-验证回滚机制。

## 20.已知限制

当前明确未实现：

-断网期间Telemetry本地缓存；
-恢复联网后的历史补传；
-普通充电宝真实电量百分比；
-电机电流和实际振动闭环检测；
-小程序内BLE一键配网；
-医学级压力值和人体真实体重测量。

断网时：

```text
本地采集继续
板端识别继续
振动提醒继续
Telemetry上传失败
断网期间历史数据不保存
```

## 21.安全说明

-比赛局域网联调可使用HTTP，正式部署必须使用HTTPS；
-后端不得明文返回`device_secret`；
-数据库建议保存设备密钥哈希或使用专用密钥管理；
-绑定码使用后应支持失效或轮换；
-普通用户只能操作自己绑定的设备；
-`factory_reset`、`enter_provisioning`和`ota_update`必须二次确认；
-OTA必须校验SHA-256，并限制可信固件来源；
-配网页面仅在设备SoftAP局域网内开放，不应暴露到公网。

## 22.后续开发入口

前后端人员首先阅读：

```text
FRONTEND_BACKEND_REQUIREMENTS.md
```

Telemetry示例：

```text
docs/telemetry_v2_example.json
```
