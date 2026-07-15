# SpineGuard 智能报告与定时报告说明

本文档说明当前后端中“用户手动生成最近数据智能报告”和“系统自动生成自然日/周/月报告”的实现逻辑、数据口径、Prompt 约束、接口以及前端调用方式。

## 1. 功能边界

当前存在两条彼此独立的报告链路：

1. 用户点击“生成报告”：后端默认查询该学生最近 600 条坐姿记录，计算统计指标，调用 LLM 生成智能报告并保存。
2. 系统自动报告：后端按北京时间自然日、自然周、自然月统计有数据的学生，自动调用 LLM 生成报告，保存后在信息中心创建未读站内通知。

两条链路都遵守以下原则：

- 用户只能读取和生成自己有权限访问的学生报告。
- 统计数字由后端算法计算，LLM 只负责解释与建议，不能重新计算或修改数字。
- 只发送匿名 `student_id` 和坐姿统计，不发送姓名、手机号、真实班级、Token 或设备密钥。
- 报告只能表述为坐姿行为风险提示或筛查参考，不能作为医学诊断。
- LLM 不可用时返回并保存规则兜底报告，前端仍能正常展示。

## 2. 用户手动生成最近 600 条智能报告

### 2.1 数据查询

用户调用报告生成接口且 `report_type=smart` 时，后端按：

```text
student_id 相等
timestamp_ms 倒序
最多 record_limit 条，默认 600，最大 1000
```

查询 `posture_records`，查询后再按时间正序分析。不足 600 条时使用该学生现有的全部记录；没有记录时返回 `404 No posture records available`。

查询按 `(device_id, session_id, seq)` 去重，历史联调产生的重复遥测不会重复进入报告统计。

### 2.2 时间和提醒口径

- 按 `(device_id, session_id)` 分组，避免不同设备会话相互连接。
- 每条记录的确认时间优先使用与下一条记录的时间差。
- 单个确认时间片最多 10 秒，避免设备断线或时间跳变造成大量虚假时长。
- `normal`、`left_lean`、`right_lean`、`front_lean`、`back_lean` 计入有效坐姿时间。
- `empty` 和 `unknown` 不计入标准或非标准坐姿比例。
- 四种倾斜连续出现时累计异常时长，用于计算最长连续异常时间。
- 提醒次数根据设备累计 `reminder_count` 的首值及后续增量计算，避免把每条遥测都算成一次提醒。

### 2.3 后端计算结果

`summary` 至少包含：

```text
record_count
data_start_at / data_end_at
effective_sitting_s
normal_sitting_s / normal_ratio
poor_sitting_s
posture_stats.normal
posture_stats.left_lean
posture_stats.right_lean
posture_stats.front_lean
posture_stats.back_lean
reminder_count
reminder_peak_day
max_continuous_abnormal_s
trend
avg_asymmetry_index
daily_items
```

每个 `posture_stats` 项包含：

```json
{
  "duration_s": 1200,
  "ratio": 0.625
}
```

趋势将数据前后两半的非标准坐姿比例进行比较：

- 后半段下降至少 5 个百分点：`improving`
- 后半段上升至少 5 个百分点：`worsening`
- 变化不足 5 个百分点：`stable`
- 有效数据不足：`insufficient_data`

### 2.4 发送给 LLM 的精简记录

后端不会发送完整压力矩阵，而是发送统计摘要和精简记录：

```json
{
  "t": 1784160000000,
  "p": "left_lean",
  "d": 2,
  "a": 0.23,
  "tx": 4.2,
  "ty": -1.3,
  "r": 3
}
```

字段分别表示时间戳、姿态、确认时长、不对称指数、两个倾角和设备累计提醒数。

### 2.5 手动智能报告 Prompt

系统提示约束 LLM：

- 只能生成坐姿行为风险提示、筛查参考和日常建议。
- 不得医学诊断，不得编造身份信息。
- 必须原样使用后端计算出的统计数字。

用户提示要求输出：

1. 标准坐姿时长和比例；
2. 左倾、右倾、前倾、后倾各自时长和比例；
3. 提醒次数；
4. 最长连续异常时间；
5. 姿态变化趋势；
6. 可执行的日常纠正建议。

## 3. 系统自动日/周/月报告

### 3.1 自动时间

后端进程运行期间按北京时间执行：

```text
日报：每天 00:10，统计前一个完整自然日
周报：每周一 00:20，统计上周一至上周日
月报：每月 1 日 00:30，统计上一个自然月
```

后端启动时默认补偿最近 7 个遗漏日报，以及最近一个完整自然周和完整自然月。只有周期内存在坐姿记录的学生才生成报告；空周期不调用 LLM、不生成报告、不创建通知。

### 3.2 自动报告内容

自动报告使用与手动报告相同的姿态时间片算法，报告至少包含：

1. 标准坐姿时长和比例；
2. 左倾、右倾、前倾、后倾各自时长和比例；
3. 总提醒次数；
4. 提醒次数最多的日期和次数；
5. 前后半段姿态趋势：改善、变差、稳定或数据不足；
6. LLM 给出的日常建议。

风险评分由后端固定算法计算，LLM不能修改风险等级和统计结果。

### 3.3 防重复和失败恢复

`scheduled_report_runs` 使用以下唯一业务键：

```text
student_id + report_type + period_start + period_end
```

后台维护循环每 5 秒运行也不会重复生成同一周期报告。任务处于 `generating` 时使用 5 分钟租约；进程异常退出后可自动接管重试。LLM 调用不长期持有 SQLite 写锁，不阻塞设备遥测入库。

相关环境变量：

```text
AUTO_REPORT_ENABLED=true
AUTO_REPORT_USE_LLM=true
AUTO_REPORT_CATCH_UP_DAYS=7
```

当 `AUTO_REPORT_USE_LLM=false` 时，自动报告使用规则模板；用户手动智能报告仍调用 LLM。

## 4. 信息中心未读和已读

自动报告成功后，后端创建：

```text
notification_type=report
student_id=报告所属学生
read_at=NULL
```

`read_at=NULL` 表示未读。通知响应中的：

```text
is_read=false
related_report_id=<对应报告ID>
```

用户点击通知后，前端先根据 `related_report_id` 获取报告详情，再调用标记已读接口。标记成功后，`read_at` 写入当前时间，后续响应为 `is_read=true`。

当前通知按学生共享。如果同一学生未来关联多个家长账号，一位家长标记已读后，其他关联家长看到的也是已读；如需账号级独立已读，应增加通知接收人表。

## 5. 接口说明

### 5.1 生成最近记录智能报告

```text
POST /api/v1/students/{student_id}/reports/generate
Authorization: Bearer <access_token>
Content-Type: application/json
```

推荐请求：

```json
{
  "report_type": "smart",
  "record_limit": 600
}
```

`report_type`、`record_limit` 均有默认值，因此 `{}` 也会生成最近 600 条智能报告。`record_limit` 范围为 1～1000。`smart` 模式始终尝试调用 LLM，忽略 `date`。

响应示意：

```json
{
  "ok": true,
  "data": {
    "report_id": 25,
    "student_id": "STU-DEMO-001",
    "report_type": "smart",
    "period_start": "2026-07-15",
    "period_end": "2026-07-16",
    "summary": {
      "record_count": 600,
      "normal_sitting_s": 720,
      "normal_ratio": 0.6,
      "posture_stats": {},
      "reminder_count": 3,
      "max_continuous_abnormal_s": 40,
      "trend": {"direction": "improving"}
    },
    "content": "LLM生成的中文报告",
    "generated_by": "llm",
    "created_at": "2026-07-16T08:00:00+00:00"
  }
}
```

### 5.2 保留的手动自然周期报告

旧用法仍兼容：

```json
{
  "report_type": "weekly",
  "use_llm": true,
  "date": "2026-07-16"
}
```

支持 `daily`、`weekly`、`monthly`。系统自动报告不依赖前端调用。

### 5.3 报告列表和详情

```text
GET /api/v1/students/{student_id}/reports
GET /api/v1/students/{student_id}/reports/{report_id}
```

### 5.4 信息中心

```text
GET  /api/v1/notifications?unread_only=false
GET  /api/v1/notifications?unread_only=true
POST /api/v1/notifications/{notification_id}/read
```

## 6. 前端应如何调用

以下示例中的 `API` 包含 `/api/v1`：

```javascript
const API = "http://127.0.0.1:8000/api/v1";
const authHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json"
};
```

### 6.1 “生成报告”按钮

前端不查询 600 条记录，也不直接调用 LLM。点击按钮后只调用后端：

```javascript
async function generateSmartReport(studentId) {
  const response = await fetch(
    `${API}/students/${studentId}/reports/generate`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        report_type: "smart",
        record_limit: 600
      })
    }
  );

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.detail || "生成报告失败");
  }
  return result.data;
}
```

按钮点击后建议显示加载状态，防止用户重复点击。返回后直接渲染 `data.summary` 和 `data.content`。

### 6.2 信息中心未读数量

```javascript
async function loadUnreadNotifications() {
  const response = await fetch(
    `${API}/notifications?unread_only=true`,
    {headers: authHeaders}
  );
  const result = await response.json();
  return result.items;
}
```

使用 `result.total` 显示未读角标。通知项中的 `notification_type === "report"` 表示自动报告通知。

### 6.3 用户点击报告通知

```javascript
async function openReportNotification(notification) {
  const reportResponse = await fetch(
    `${API}/students/${notification.student_id}/reports/${notification.related_report_id}`,
    {headers: authHeaders}
  );
  const reportResult = await reportResponse.json();
  if (!reportResponse.ok) {
    throw new Error(reportResult.detail || "加载报告失败");
  }

  await fetch(
    `${API}/notifications/${notification.notification_id}/read`,
    {method: "POST", headers: authHeaders}
  );

  return reportResult.data;
}
```

推荐在报告详情成功加载后再标记已读。完成后刷新信息中心列表或在本地将该通知的 `is_read` 更新为 `true`。

### 6.4 展示注意事项

- 时间字段单位为秒，前端可格式化为“小时/分钟”。
- 比例为 0～1，显示时乘 100 并格式化为百分比。
- `generated_by=llm_fallback` 时仍可正常展示，可附加“智能服务暂不可用，已使用规则报告”的轻提示。
- 前端不得向用户展示医学诊断措辞，应沿用后端返回的“坐姿行为风险提示/筛查参考”。
