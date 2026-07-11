# API 接口契约

本文档定义 Web、微信小程序、设备与后端之间的接口边界。FastAPI 自动生成的 `/docs` 用于验证实现是否和本文档一致。

## 通用规则

- 统一接口前缀：`/api/v1`。
- 用户端接口使用 JWT：`Authorization: Bearer <token>`。
- 设备上传接口使用设备 Token：`X-Device-Token: <device_token>`。
- JSON 字段统一使用 `snake_case`。
- 风险结果只能表述为坐姿行为风险提示或筛查参考，不能表述为医学诊断。

## 通用返回格式

单对象成功：

```json
{
  "ok": true,
  "data": {}
}
```

列表成功：

```json
{
  "ok": true,
  "items": [],
  "total": 0
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "DEVICE_NOT_BOUND",
    "message": "设备尚未绑定学生"
  }
}
```

## 认证接口

### 注册

```text
POST /api/v1/auth/register
```

用途：创建家长、管理员或校医账号。比赛演示阶段可由后端预置管理员账号。

请求：

```json
{
  "username": "parent_demo",
  "password": "demo-password",
  "role": "parent"
}
```

返回：

```json
{
  "ok": true,
  "data": {
    "user_id": "USR-DEMO-001",
    "username": "parent_demo",
    "role": "parent"
  }
}
```

### 登录

```text
POST /api/v1/auth/login
```

返回 JWT，Web 和小程序共用同一账号体系。

### 当前用户

```text
GET /api/v1/me
```

用途：前端刷新页面后恢复用户身份和角色。

## 学生与设备接口

### 学生列表

```text
GET /api/v1/students
```

家长返回自己可见的学生；管理员返回权限范围内的学生。

### 创建设备绑定

```text
POST /api/v1/devices/bind
```

请求：

```json
{
  "device_id": "SG-0001",
  "student_id": "STU-DEMO-001",
  "bind_code": "123456"
}
```

### 设备状态

```text
GET /api/v1/devices/{device_id}/status
```

返回设备在线状态、电量、固件版本、最后上传时间。

## 设备上传接口

### 上传遥测数据

```text
POST /api/v1/device/telemetry
```

认证：`X-Device-Token`

请求体遵守 `shared/schema.json`。后端负责校验、写入 `posture_records`、更新设备最新状态。

## 实时和历史数据接口

### 当前坐姿

```text
GET /api/v1/students/{student_id}/latest
```

用途：Web 实时坐姿页、小程序首页。

返回：

```json
{
  "ok": true,
  "data": {
    "student_id": "STU-DEMO-001",
    "device_id": "SG-0001",
    "posture": "left_lean",
    "confidence": 0.92,
    "risk_level": "yellow",
    "pressure": {
      "left": 820,
      "right": 310,
      "front": 460,
      "back": 590,
      "center": 710
    },
    "pressure_features": {
      "total_pressure": 2890,
      "left_right_diff": 510,
      "front_back_diff": -130,
      "center_x": -0.46,
      "center_y": -0.08,
      "asymmetry_index": 0.35
    },
    "warning_active": true,
    "reminder_count": 3,
    "battery_level": 86,
    "timestamp_ms": 1783660800000
  }
}
```

### 历史记录

```text
GET /api/v1/students/{student_id}/history?from=&to=&limit=500
```

用途：趋势图、坐姿回放、统计计算。

### 每日统计

```text
GET /api/v1/students/{student_id}/stats/daily?date=2026-07-11
```

返回标准坐姿时长、不良坐姿时长、各坐姿比例、提醒次数和压力不对称趋势摘要。

### 每周统计

```text
GET /api/v1/students/{student_id}/stats/weekly?week=2026-W28
```

用途：周报和趋势页。

### 风险提示

```text
GET /api/v1/students/{student_id}/risk
```

返回：

```json
{
  "ok": true,
  "data": {
    "risk_level": "yellow",
    "risk_score": 62,
    "risk_reasons": [
      "近 7 天左/右压力不对称指数偏高",
      "单次不良坐姿持续时间较长"
    ],
    "suggestion": "建议关注坐姿习惯，并在持续异常时作为进一步筛查参考。"
  }
}
```

## 报告接口

### 报告列表

```text
GET /api/v1/students/{student_id}/reports
```

### 生成报告

```text
POST /api/v1/students/{student_id}/reports/generate
```

请求：

```json
{
  "report_type": "weekly",
  "use_llm": true
}
```

后端整理最近 24 小时或 7 天匿名统计摘要，再调用大模型生成报告。不得向大模型发送学生姓名、手机号或真实班级信息。

## 管理员接口

### 学校总览

```text
GET /api/v1/admin/overview
```

返回活跃设备数、平均标准坐姿率、高风险提示人数、班级趋势摘要。

### 班级列表

```text
GET /api/v1/admin/classes
```

### 班级学生状态

```text
GET /api/v1/admin/classes/{class_id}/students
```

### 高风险提示学生列表

```text
GET /api/v1/admin/risk-students
```

### 数据导出

```text
GET /api/v1/admin/export?from=&to=&format=csv
```

支持 `csv`，后续可增加 `xlsx`。导出数据不得包含 Wi-Fi 密码、Token、手机号或真实班级信息。

## 实时推送

第一阶段可以使用 1 秒轮询。后续增加 WebSocket：

```text
WS /api/v1/ws/students/{student_id}
```

用途：实时坐姿状态、设备在线状态、提醒状态推送。

