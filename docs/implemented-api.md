# 当前已实现接口说明

本文档用于同步给前端和小程序同学，记录当前后端已经实现、可以开始联调的接口。总体规划仍以 `docs/api-contract.md` 为接口契约；如果两者有差异，联调时先以本文档和 FastAPI `/docs` 为准。

## 和接口契约的阶段性差异

- 当前用户接口同时支持 `GET /api/v1/auth/me` 和兼容契约的 `GET /api/v1/me`。
- 当前历史记录接口已支持 `from`、`to`、`limit`，其中 `from/to` 支持毫秒时间戳、`YYYY-MM-DD` 或 ISO datetime。
- 当前设备绑定接口支持可选 `bind_code` 字段，但暂不校验。
- 当前 WebSocket 同时支持设备维度 `WS /api/v1/ws/devices/{device_id}` 和学生维度 `WS /api/v1/ws/students/{student_id}?token=<access_token>`。
- 当前已实现每日统计和每周统计接口，统计口径基于 `session_id` 分组和相邻遥测时间片估算。
- 当前 LLM 智能报告会读取 `backend/.env` 并调用 OpenAI-compatible `/chat/completions`；调用失败时自动返回规则兜底内容。
- 当前已实现管理员总览、班级列表、班级详情统计、高风险学生列表、CSV/Excel 导出和小程序通知接口。
- 当前已实现后端权威的种树游戏账户、姿态状态机、连续奖励、每日任务、资源操作、奖励流水和游戏 WebSocket。
- 当前已实现日报、自然周报、自然月报定时生成，并在生成成功后创建站内通知。

## 通用规则

- 后端地址示例：`http://127.0.0.1:8000`
- API 前缀：`/api/v1`
- FastAPI 自动文档：`http://127.0.0.1:8000/docs`
- 用户端接口认证：`Authorization: Bearer <access_token>`
- 设备上传接口认证：`X-Device-Token: <device_token>`
- JSON 字段统一使用 `snake_case`
- 风险结果只能表述为坐姿行为风险提示或筛查参考，不得表述为医学诊断
- 不在接口、数据库或报告中提交 Wi-Fi 密码、真实 Token、学生姓名、手机号或真实班级信息

## 测试账号

本地开发数据库中已有两个测试账号：

```text
username: parent_demo
password: parent123
role: parent

username: school_admin_demo
password: admin123
role: school_admin
```

## 健康检查

### `GET /health`

返回后端运行状态。

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

## 认证接口

### `POST /api/v1/auth/register`

创建用户。

请求：

```json
{
  "username": "parent_demo_2",
  "password": "parent123",
  "role": "parent"
}
```

`role` 可选：

```text
parent
school_admin
doctor
admin
```

返回：

```json
{
  "ok": true,
  "data": {
    "user_id": "USR-XXXXXXXXXXXX",
    "username": "parent_demo_2",
    "role": "parent"
  }
}
```

### `POST /api/v1/auth/login`

登录并返回 Bearer Token。前端和小程序后续请求用户端接口时，把 `access_token` 放入 `Authorization` 头。

请求：

```json
{
  "username": "parent_demo",
  "password": "parent123"
}
```

返回：

```json
{
  "access_token": "<token>",
  "token_type": "bearer",
  "user": {
    "user_id": "USR-DEMO-PARENT",
    "username": "parent_demo",
    "role": "parent"
  }
}
```

后续请求头：

```text
Authorization: Bearer <access_token>
```

### `GET /api/v1/auth/me`

获取当前登录用户。需要 Bearer Token。

返回：

```json
{
  "ok": true,
  "data": {
    "user_id": "USR-DEMO-PARENT",
    "username": "parent_demo",
    "role": "parent"
  }
}
```

### `GET /api/v1/me`

兼容原接口契约的当前用户接口。返回内容与 `GET /api/v1/auth/me` 相同。

## 学生接口

### `GET /api/v1/students`

获取学生列表。家长只能看到自己关联的学生；`school_admin`、`doctor`、`admin` 可以看到全部学生。

### `POST /api/v1/students`

创建匿名学生档案。家长创建后会自动建立 `user_student_links` 关系。

请求：

```json
{
  "display_code": "STU-DEMO-LOCAL",
  "school_id": "SCH-DEMO",
  "class_id": "CLASS-DEMO"
}
```

### `GET /api/v1/students/{student_id}`

获取学生详情。沿用学生权限规则。

### `GET /api/v1/students/{student_id}/latest`

按学生查询最新坐姿记录。

### `GET /api/v1/students/{student_id}/history?from=&to=&limit=100`

按学生查询历史坐姿记录。`limit` 范围为 `1~2000`。

`from` 和 `to` 可选，支持：

```text
1783785600000
2026-07-11
2026-07-11T08:00:00+08:00
```

### `GET /api/v1/students/{student_id}/stats/daily?date=2026-07-11`

按学生和日期计算每日统计，并写入/更新 `daily_stats`。

当前统计口径：

- `normal_sitting_s`：按 `session_id` 分组后，根据相邻遥测点时间差估算的标准坐姿时长
- `poor_sitting_s`：按 `session_id` 分组后，根据相邻遥测点时间差估算的非标准姿态时长之和
- `normal_ratio`：标准坐姿时长占比
- 各类倾斜次数：按姿态切换次数估算
- `reminder_count`：按会话内提醒计数变化估算，单条记录时回退为当前提醒次数
- `avg_asymmetry_index`：当天非 `empty` 记录平均压力不对称指数

### `GET /api/v1/students/{student_id}/stats/weekly?week=2026-W28`

按学生查询每周统计。`week` 支持 ISO 周格式 `YYYY-Www`，也支持传入某一天的 `YYYY-MM-DD`。

返回：

```json
{
  "ok": true,
  "data": {
    "student_id": "STU-DEMO-001",
    "week": "2026-W28",
    "period_start": "2026-07-06",
    "period_end": "2026-07-12",
    "total_sitting_s": 3600,
    "normal_sitting_s": 2600,
    "poor_sitting_s": 1000,
    "normal_ratio": 0.7222,
    "reminder_count": 6,
    "avg_asymmetry_index": 0.24,
    "daily_items": []
  }
}
```

### `GET /api/v1/students/{student_id}/risk?date=2026-07-11`

基于近 7 天每日统计生成坐姿行为风险提示。

返回：

```json
{
  "ok": true,
  "data": {
    "student_id": "STU-DEMO-001",
    "period_start": "2026-07-05",
    "period_end": "2026-07-11",
    "risk_level": "yellow",
    "risk_score": 45,
    "risk_reasons": ["近 7 天存在一定非标准坐姿占比"],
    "suggestion": "存在一定坐姿行为风险，建议关注坐姿习惯并增加休息和纠正提醒。"
  }
}
```

### `GET /api/v1/students/{student_id}/reports`

获取该学生已生成报告列表。

### `GET /api/v1/students/{student_id}/reports/{report_id}`

获取单份报告详情。自动报告通知会返回 `related_report_id`，前端可使用该接口打开对应报告。

### `POST /api/v1/students/{student_id}/reports/generate`

默认读取该学生最近 600 条坐姿记录并调用 LLM 生成智能报告，也兼容手动生成日报、周报或月报。

请求：

```json
{
  "report_type": "smart",
  "record_limit": 600
}
```

说明：

- `report_type` 可选 `smart`、`daily`、`weekly`、`monthly`，默认为 `smart`
- `smart` 默认读取最近 600 条，`record_limit` 范围为 1～1000，并始终尝试调用 LLM
- `smart` 报告由后端计算五类姿态时长/比例、提醒次数、最长异常时长和趋势，再把匿名摘要及精简记录发给 LLM
- `daily/weekly/monthly` 保留原有手动周期报告能力
- `use_llm=false` 时生成规则报告
- `use_llm=true` 时调用 `backend/.env` 中配置的大模型服务，接口按 OpenAI-compatible `/chat/completions` 请求
- 真实 LLM 密钥只在 `backend/.env` 中填写，不能提交到 GitHub
- 如果 LLM 配置缺失、服务超时或返回格式不兼容，后端会返回 `generated_by=llm_fallback` 的规则兜底报告

### 自动报告和站内通知

后端后台任务按北京时间自动生成：

```text
日报：每天 00:10，生成前一个完整自然日
周报：每周一 00:20，生成上周一至上周日
月报：每月 1 日 00:30，生成上一个自然月
```

自动报告规则：

- 报告周期和每日统计均按北京时间自然日切分，不按 UTC 日期切分。
- 只有学生在对应周期内存在坐姿遥测时才生成，空周期不生成报告或通知，也不调用 LLM。
- 统计值和风险等级由固定算法计算；LLM 只负责将匿名统计摘要整理成自然语言。
- 默认尝试现有 LLM API，调用失败时仍保存 `generated_by=llm_fallback` 的规则报告。
- 同一学生、报告类型和自然周期只自动生成一次；后台循环重复执行或后端重启不会重复生成。
- 后端启动时默认补偿最近 7 个完整自然日中遗漏的日报，并补偿最近一个完整自然周和完整自然月。
- 自动报告成功后写入一条 `notification_type=report` 的站内通知，前端通过 `GET /api/v1/notifications` 获取。
- 自动报告摘要包含五类姿态时长/比例、总提醒、提醒峰值日、最长异常时长和前后半段趋势。
- 报告通知初始 `is_read=false`，并返回 `related_report_id`；调用标记已读接口后变为 `is_read=true`。

可在 `backend/.env` 配置：

```text
AUTO_REPORT_ENABLED=true
AUTO_REPORT_USE_LLM=true
AUTO_REPORT_CATCH_UP_DAYS=7
```

`AUTO_REPORT_USE_LLM=false` 时自动报告完全使用规则模板，不调用 LLM。手动报告接口的 `use_llm` 参数不受该开关影响。

## 设备接口

### `GET /api/v1/devices`

获取设备列表。家长只能看到自己学生绑定的设备；`school_admin`、`doctor`、`admin` 可以看到全部设备。

### `POST /api/v1/devices`

创建设备。需要 `school_admin` 或 `admin`。

请求：

```json
{
  "device_id": "SG-TEST-001",
  "device_token": "device-secret",
  "firmware_version": "0.1.0",
  "model_version": "rule-v0.1"
}
```

### `GET /api/v1/devices/{device_id}/status`

查询设备状态、电量、固件版本、模型版本和最后在线时间。

### `POST /api/v1/devices/bind`

绑定设备到学生。

请求：

```json
{
  "device_id": "SG-TEST-001",
  "student_id": "STU-DEMO-001",
  "bind_code": "123456"
}
```

绑定规则：

- 家长只能绑定到自己关联的学生
- 同一设备同一时间只保留一个有效绑定
- 同一学生同一时间只保留一个有效设备；绑定新设备时会解除该学生的旧设备绑定
- 创建新绑定时，旧的 `active=true` 绑定会自动失效
- `bind_code` 当前可选接收，暂不校验

### `GET /api/v1/devices/{device_id}/latest`

按设备查询最新坐姿记录。当前保留用于设备联调。

### `GET /api/v1/devices/{device_id}/history?from=&to=&limit=100`

按设备查询历史坐姿记录。当前保留用于设备联调。`from/to/limit` 规则同学生历史接口。

## 设备上传接口

### `POST /api/v1/device/telemetry`

设备上传遥测数据。认证方式：

```text
X-Device-Token: dev-token
```

请求体遵守：

```text
shared/schema.json
docs/telemetry-contract.md
```

当前处理逻辑：

1. 校验设备 Token
2. 校验遥测字段
3. 根据 `device_id` 查当前有效绑定
4. 写入 `posture_records`
5. 如果存在绑定，写入 `student_id`
6. 更新设备在线状态、电量、固件版本和模型版本
7. 广播 WebSocket

此外，绑定学生的遥测会进入游戏状态机。`(device_id, session_id, seq)` 重复上传返回 `duplicate=true`，但不会重复累计、提醒或发奖。乱序 `seq` 可保留原始记录，但不会倒推已结算的游戏状态。

## 游戏接口

游戏后端规则版本为 `garden-v1`。后端不保存护脊运动，不提供专注会话接口；Web 和小程序的 15/30/45/60 分钟专注倒计时完全在前端运行，不能改变成长、资源、任务或奖励流水。

### `GET /api/v1/game/rules`

返回生长期、连续里程碑、资源操作、时间阈值和规则版本。

### `GET /api/v1/students/{student_id}/garden`

返回乐园完整状态，包括：

```text
growth / stage / resources
today_normal_s / continuous_normal_s
reminder_count / reminder_rate_30m
daily_growth_granted / daily_growth_remaining
device_online / instant_tree_state / recovery_needed
tasks / rule_version / server_time / updated_at
```

设备最后一次服务端接收遥测超过 10 秒后，`device_online=false` 且 `instant_tree_state=offline`。超过 5 分钟后设备学习会话结束。

### `POST /api/v1/students/{student_id}/daily-tasks/{task_id}/claim`

可手动领取的任务：

```text
daily_normal_30
continuous_25
```

请求：

```json
{"idempotency_key": "client-generated-unique-key"}
```

`daily_reminder_lt_5` 和 `active_rest_after_60` 由后端自动发放，不能手动领取。护脊运动任务不在后端实现。

### `POST /api/v1/students/{student_id}/garden/actions`

请求：

```json
{
  "action": "water",
  "quantity": 1,
  "idempotency_key": "client-generated-unique-key"
}
```

操作支持 `sunbathe`、`water`、`fertilize`、`recover_tree`。`quantity` 为 1～5，`recover_tree` 必须为 1。资源校验、扣减、成长增加和流水写入在同一事务中完成。

### `GET /api/v1/students/{student_id}/reward-ledger?cursor=&limit=50`

分页返回成长和资源流水。流水不包含健康值。

### `WS /api/v1/ws/students/{student_id}/game?token=<access_token>`

推送 `garden.updated`、`posture.state_changed`、`abnormal.reminded`、`continuous.reset` 和 `milestone.granted` 等事件。断线恢复时应重新请求 `GET garden`。

### 游戏结算口径

- 异常 30 秒提醒一次，60 秒连续正确时长清零，同一异常片段不重复处理。
- 恢复 `normal` 稳定 5 秒后关闭异常片段。
- `empty`、`unknown` 和离线均暂停正确计时；`unknown` 不计入不良坐姿。
- 连续里程碑 5/15/30/45/60 分钟实时发放资源。
- 基础成长每天 20:00 按 `Asia/Shanghai` 结算，每日最多 180 点。
- 20:00 后新增的当日数据会在下一次 20:00 补结算，并继续占用原自然日额度。
- 如果后端在 20:00 未运行，下次启动会幂等补发过往未结算数据。
- 每个确认时间片最多 10 秒，设备断线期间不会累计时长、提醒或奖励。

业务冲突使用 HTTP 409，`detail.code` 可能为：

```text
INSUFFICIENT_RESOURCE
TASK_NOT_CLAIMABLE
TASK_ALREADY_CLAIMED
POSTURE_STILL_ABNORMAL
RECOVERY_NOT_NEEDED
INVALID_QUANTITY
```

## WebSocket

### `WS /api/v1/ws/devices/{device_id}`

按设备推送实时遥测。当前不做用户鉴权，主要用于设备联调。

### `WS /api/v1/ws/students/{student_id}?token=<access_token>`

按学生推送实时遥测。需要把登录接口返回的 `access_token` 放在 query 参数 `token` 中。

前端示例：

```text
ws://127.0.0.1:8000/api/v1/ws/students/STU-DEMO-001?token=<access_token>
```

家长只能订阅自己关联的学生；`school_admin`、`doctor`、`admin` 可以订阅全部学生。

## 管理员接口

### `GET /api/v1/admin/overview`

管理员总览。需要 `school_admin` 或 `admin`。

返回：

```json
{
  "ok": true,
  "data": {
    "student_count": 12,
    "device_count": 10,
    "active_device_count": 8,
    "average_normal_ratio": 0.76,
    "high_risk_student_count": 2,
    "class_summaries": [
      {
        "class_id": "CLASS-DEMO",
        "student_count": 12,
        "average_normal_ratio": 0.76,
        "high_risk_student_count": 2
      }
    ]
  }
}
```

### `GET /api/v1/admin/export?from=&to=&format=csv`

导出匿名坐姿记录 CSV。需要 `school_admin` 或 `admin`。

说明：

- `format` 支持 `csv` 和 `xlsx`
- `from/to` 规则同历史接口
- 导出字段不包含设备 Token、用户手机号、学生姓名或真实班级信息
- 当前导出的是 `posture_records` 中的匿名坐姿记录

### `GET /api/v1/admin/classes`

班级列表统计。需要 `school_admin` 或 `admin`。

返回每个班级的学生数、设备数、在线设备数、平均标准坐姿率和高风险学生数量。

### `GET /api/v1/admin/classes/{class_id}/students`

班级学生状态。需要 `school_admin` 或 `admin`。

返回该班级下每个匿名学生的平均标准坐姿率、累计坐姿时长、提醒次数、最新风险等级和风险分数。

`class_id=unassigned` 表示查询未分班学生。

### `GET /api/v1/admin/risk-students?risk_level=red`

高风险提示学生列表。需要 `school_admin`、`admin` 或 `doctor`。

`risk_level` 可选：

```text
green
yellow
red
all
```

默认查询 `red`。

### `GET /api/v1/admin/risk-students/export?risk_level=red&from=&to=`

下载风险学生非正常坐姿记录压缩包。需要 `school_admin`、`admin` 或 `doctor`。

返回 `application/zip`。zip 解压后，每个文件为一个学生的 Excel 表格，文件名格式：

```text
{student_id}_{download_timestamp}.xlsx
```

每个表格只包含该学生的非正常坐姿记录，即排除 `normal` 和 `empty`，包含 `left_lean`、`right_lean`、`front_lean`、`back_lean`、`unknown` 等记录。

参数说明：

- `risk_level` 可选 `green`、`yellow`、`red`、`all`，默认 `red`
- `from/to` 可选，规则同历史接口
- 导出内容不包含设备 Token、用户手机号、学生姓名或真实班级信息

## 小程序通知接口

### `GET /api/v1/notifications?unread_only=false`

获取当前用户可见通知。家长能看到发给自己的通知、发给自己关联学生的通知、全局通知；管理员/校医可查看全部通知。

### `POST /api/v1/notifications`

创建通知。需要 `school_admin` 或 `admin`。

请求：

```json
{
  "student_id": "STU-DEMO-001",
  "notification_type": "risk",
  "title": "坐姿风险提示",
  "content": "请关注近期坐姿行为风险提示。"
}
```

`notification_type` 可选：

```text
system
risk
reminder
report
```

### `POST /api/v1/notifications/{notification_id}/read`

标记通知已读。需要当前用户对该通知有可见权限。

## 尚未实现

以下接口仍是后续计划：

- 微信订阅消息、邮件等站外推送
- 更细的统计图表专用聚合接口
- Alembic 数据库迁移脚本
