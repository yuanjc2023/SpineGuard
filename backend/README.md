# SpineGuard 后端说明

本目录是 SpineGuard 的 FastAPI 后端。当前阶段已经完成基础业务接口、种树游戏模块，以及日报、自然周报、自然月报自动生成和站内通知。

## 当前能力

- 接收 ESP32-S3 或模拟设备上传的遥测数据。
- 使用 Pydantic 校验设备上传字段。
- 使用设备 Token 保护设备上传接口。
- 将设备上传数据写入 `posture_records`。
- 提供设备最新数据和历史数据查询。
- 提供账号注册、登录和当前用户查询。
- 提供学生创建/查询、设备创建/查询和设备绑定。
- 兼容原接口契约中的 `GET /api/v1/me`。
- 设备上传时会按当前有效绑定写入 `student_id`。
- 提供按学生查询最新坐姿和历史坐姿接口。
- 历史查询支持 `from`、`to`、`limit`。
- 提供按学生和日期计算每日统计、每周统计接口，统计口径基于 `session_id` 和相邻遥测时间片估算。
- 提供坐姿行为风险提示接口。
- 提供规则报告和真实 LLM 智能报告接口，LLM 不可用时自动兜底为规则报告。
- 设备上传时自动更新设备在线状态、电量、固件版本和模型版本。
- 提供设备维度和学生维度 WebSocket 推送入口。
- 提供管理员总览、班级统计、高风险学生列表和匿名坐姿记录 CSV/Excel 导出。
- 提供小程序通知列表、通知创建和标记已读接口。
- 启动时自动创建数据库表。
- 同一学生同一时间只允许一个有效设备绑定。
- 遥测按 `(device_id, session_id, seq)` 幂等接收，重复数据不重复结算。
- 10 秒无遥测显示离线，5 分钟无遥测自动结束设备会话。
- 专注倒计时和护脊运动只由前端实现，不进入后端游戏账户。
- 自动报告使用固定算法生成统计与风险结论，可选使用 LLM 增强文字，失败时保存规则兜底报告。
- 提供独立测试数据库，避免 pytest 清空正式开发数据库。

## 目录结构

```text
backend/
├─ app/
│  ├─ main.py                 FastAPI 应用入口
│  ├─ config.py               API 前缀、版本、Token、.env、数据库路径
│  ├─ db.py                   SQLAlchemy engine/session/init_db
│  ├─ models.py               数据库表模型
│  ├─ schemas.py              设备遥测 Pydantic 模型
│  ├─ state.py                临时内存缓存 latest/history/subscribers
│  ├─ routes/
│  │  ├─ admin.py             管理员总览、CSV 导出
│  │  ├─ auth.py              注册、登录、当前用户
│  │  ├─ devices.py           设备创建、查询、绑定
│  │  ├─ health.py            健康检查接口
│  │  ├─ game.py              乐园、任务、资源、流水和游戏 WebSocket
│  │  ├─ notifications.py     小程序通知
│  │  ├─ students.py          学生创建、查询
│  │  └─ telemetry.py         设备遥测相关接口
│  └─ services/
│     ├─ auth.py              密码哈希、JWT 生成和校验
│     ├─ reports.py           规则报告和 LLM 报告生成
│     ├─ game.py              游戏状态机、结算和账户服务
│     ├─ game_realtime.py     游戏事件推送
│     ├─ maintenance.py       离线、20:00 成长和日终任务维护
│     ├─ scheduled_reports.py 自动日报、周报、月报和站内通知
│     ├─ risk.py              坐姿行为风险提示计算
│     ├─ stats.py             每日统计计算和落库
│     └─ telemetry.py         遥测保存、查询、WebSocket 广播
├─ tests/
│  └─ test_api.py             后端 API 测试
├─ requirements.txt
├─ spineguard.db              本地开发数据库，不提交 Git
└─ test_spineguard.db         pytest 测试数据库，不提交 Git
```

## 数据库

默认数据库固定为：

```text
backend/spineguard.db
```

配置位于 `app/config.py`：

```python
DEFAULT_SQLITE_PATH = PROJECT_ROOT / "backend" / "spineguard.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}")
```

因此，不管从项目根目录还是 `backend/` 目录启动后端，默认都会使用同一个数据库文件。

如需切换到 MySQL，可通过环境变量覆盖：

```powershell
$env:DATABASE_URL="mysql+pymysql://user:password@127.0.0.1:3306/spineguard"
```

不要把真实数据库密码写入代码或提交到 GitHub。

## 本地环境变量

后端启动时会自动读取：

```text
backend/.env
```

当前 `.env` 已提供本地占位配置：

```text
SPINEGUARD_DEVICE_TOKEN=dev-token
SPINEGUARD_SECRET_KEY=dev-secret-change-me
ACCESS_TOKEN_EXPIRE_MINUTES=1440
LLM_API_KEY=填入你的LLM_API_KEY
LLM_API_BASE=填入你的LLM_API_BASE
LLM_MODEL=填入你的模型名称
LLM_TIMEOUT_SECONDS=20
AUTO_REPORT_ENABLED=true
AUTO_REPORT_USE_LLM=true
AUTO_REPORT_CATCH_UP_DAYS=7
```

`.env` 已被 `.gitignore` 忽略，不应提交到 GitHub。你后续接入真实 LLM 时，只需要在本机修改 `backend/.env`，不要把真实密钥发到仓库或聊天记录里。

自动报告和每日统计均按北京时间自然日切分：日报每天 00:10，周报每周一 00:20，月报每月 1 日 00:30。对应周期没有坐姿数据时跳过；生成成功后创建 `report` 类型站内通知。启动时会补偿遗漏周期，唯一任务记录确保不会重复生成。

## 当前表结构

当前 SQLAlchemy 会创建以下表：

```text
users
students
user_student_links
devices
device_bindings
posture_records
daily_stats
risk_assessments
reports
scheduled_report_runs
reminder_events
notifications
telemetry_receipts
device_session_states
abnormal_episodes
growth_settlement_segments
garden_accounts
game_daily_progress
reward_ledger
milestone_claims
daily_task_states
idempotency_records
```

主要用途：

- `users`：用户账号、密码哈希、角色。
- `students`：学生匿名档案。
- `user_student_links`：用户和学生关系。
- `devices`：设备基础信息、固件版本、电量、在线状态。
- `device_bindings`：设备和学生绑定关系。
- `posture_records`：每次设备上传的原始坐姿记录。
- `daily_stats`：每日统计。
- `risk_assessments`：坐姿行为风险提示。
- `reports`：日报、周报、月报或智能报告。
- `scheduled_report_runs`：自动报告周期、状态、报告 ID 和通知 ID，用于防止重复生成。
- `reminder_events`：提醒事件。
- `notifications`：小程序通知。
- `telemetry_receipts`：遥测业务唯一回执，用于阻止重复结算。
- `device_session_states`、`abnormal_episodes`：设备会话和异常片段状态机。
- `game_daily_progress`、`growth_settlement_segments`：自然日进度和 20:00 成长结算段。
- `garden_accounts`、`reward_ledger`：成长、资源账户和只追加流水。
- `milestone_claims`、`daily_task_states`：连续里程碑和每日任务。
- `idempotency_records`：任务领取与资源操作的请求幂等结果。

## 游戏模块

```text
GET  /api/v1/game/rules
GET  /api/v1/students/{student_id}/garden
POST /api/v1/students/{student_id}/daily-tasks/{task_id}/claim
POST /api/v1/students/{student_id}/garden/actions
GET  /api/v1/students/{student_id}/reward-ledger?cursor=&limit=50
WS   /api/v1/ws/students/{student_id}/game?token=<access_token>
```

基础成长在每天北京时间 20:00 结算，当天总上限为 180 点。后端错过结算时刻时会在下一次启动补发；20:00 后产生的数据在下一次 20:00 补结算，仍归属于原自然日。连续里程碑资源实时发放。

前端专注页面只负责 15/30/45/60 分钟倒计时。后端没有 `focus_sessions`、护脊运动完成接口或专注奖励来源，专注操作不会改变乐园状态。

## 测试用户

本地开发数据库中已创建两个匿名测试账号：

```text
username: parent_demo
password: parent123
role: parent
user_id: USR-DEMO-PARENT

username: school_admin_demo
password: admin123
role: school_admin
user_id: USR-DEMO-ADMIN
```

这两个账号可用于登录接口测试。密码以测试哈希形式保存，不保存明文。

## 已有接口

### 健康检查

```text
GET /health
```

返回：

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

### 上传设备遥测

```text
POST /api/v1/device/telemetry
Header: X-Device-Token: dev-token
```

请求体遵守 `shared/schema.json` 和 `docs/telemetry-contract.md`。

当前逻辑：

1. 校验 `X-Device-Token`。
2. 校验遥测字段。
3. 写入 `posture_records`。
4. 更新内存 `latest` 缓存。
5. 广播给 WebSocket 订阅者。

### 用户注册

```text
POST /api/v1/auth/register
```

请求：

```json
{
  "username": "parent_demo_2",
  "password": "parent123",
  "role": "parent"
}
```

### 用户登录

```text
POST /api/v1/auth/login
```

请求：

```json
{
  "username": "parent_demo",
  "password": "parent123"
}
```

返回 `access_token`，后续用户端接口使用：

```text
Authorization: Bearer <access_token>
```

### 当前用户

```text
GET /api/v1/auth/me
```

需要 Bearer Token。

### 学生接口

```text
GET  /api/v1/students
POST /api/v1/students
GET  /api/v1/students/{student_id}
GET  /api/v1/students/{student_id}/latest
GET  /api/v1/students/{student_id}/history?from=&to=&limit=100
GET  /api/v1/students/{student_id}/stats/daily?date=2026-07-11
GET  /api/v1/students/{student_id}/stats/weekly?week=2026-W28
GET  /api/v1/students/{student_id}/risk?date=2026-07-11
GET  /api/v1/students/{student_id}/reports
POST /api/v1/students/{student_id}/reports/generate
```

家长创建学生后会自动建立 `user_student_links` 关系。家长只能查看自己关联的学生；学校管理员、校医和管理员可查看全部学生。

学生维度的 latest/history 会从 `posture_records.student_id` 查询数据。设备上传时，如果 `device_bindings` 中存在当前有效绑定，后端会自动把绑定的 `student_id` 写入坐姿记录。

每日统计接口会读取指定日期的 `posture_records`，计算并写入/更新 `daily_stats`。当前统计口径：

- 标准坐姿时长：按 `session_id` 分组后，根据相邻遥测点时间差估算 `normal` 时长。
- 非标准坐姿时长：按 `session_id` 分组后，根据相邻遥测点时间差估算 `left_lean`、`right_lean`、`front_lean`、`back_lean`、`unknown` 时长。
- 各类异常次数：按姿态切换次数估算。
- 提醒次数：按会话内提醒计数变化估算，单条记录时回退为当前提醒次数。
- 平均不对称指数：当天非 `empty` 记录的平均 `asymmetry_index`。

这是基于当前遥测频率的会话级近似统计；设备上传频率越稳定，时长估算越准确。

风险提示接口会基于近 7 天每日统计，返回：

```text
risk_level: green / yellow / red
risk_score: 0~100
risk_reasons: 风险原因列表
suggestion: 行为建议和筛查参考
```

风险结果只能作为坐姿行为风险提示或筛查参考，不能表述为医学诊断。

报告生成接口请求示例：

```json
{
  "report_type": "weekly",
  "use_llm": true,
  "date": "2026-07-11"
}
```

`use_llm=false` 时生成规则报告。`use_llm=true` 时后端会调用 `backend/.env` 中配置的大模型服务，接口按 OpenAI-compatible `/chat/completions` 请求。配置示例：

```text
LLM_API_KEY=your-local-secret
LLM_API_BASE=https://example.com/v1
LLM_MODEL=your-model-name
LLM_TIMEOUT_SECONDS=20
```

不要把真实密钥、Token、学生姓名、手机号或真实班级信息提交到 GitHub。发送给模型的数据只包含匿名 `student_id` 和统计摘要。若 LLM 配置缺失、服务超时或返回格式不兼容，后端会返回 `generated_by=llm_fallback` 的规则兜底报告。

### 设备接口

```text
GET  /api/v1/devices
POST /api/v1/devices
GET  /api/v1/devices/{device_id}/status
POST /api/v1/devices/bind
```

创建设备需要 `school_admin` 或 `admin` 角色。绑定设备需要登录用户，当前阶段会记录绑定操作者。

绑定规则：

- 家长只能把设备绑定到自己关联的学生。
- 同一设备同一时间只保持一个有效绑定。
- 新绑定创建时，旧的 `active=true` 绑定会自动置为 `active=false`。
- 设备上传数据时，设备状态会更新为 `online`，并同步电量、固件版本和模型版本。

### 查询设备最新数据

```text
GET /api/v1/devices/{device_id}/latest
```

优先从内存缓存读取；如果后端刚启动且内存为空，会从数据库读取最后一条记录。

### 查询设备历史数据

```text
GET /api/v1/devices/{device_id}/history?from=&to=&limit=100
```

从数据库读取最近记录。`limit` 范围为 `1~2000`。`from` 和 `to` 可选，支持毫秒时间戳、`YYYY-MM-DD` 或 ISO datetime。

### WebSocket

```text
WS /api/v1/ws/devices/{device_id}
WS /api/v1/ws/students/{student_id}?token=<access_token>
```

设备维度 WebSocket 主要用于设备联调。学生维度 WebSocket 需要登录 token，家长只能订阅自己关联的学生，管理员/校医可订阅全部学生。

### 管理员接口

```text
GET /api/v1/admin/overview
GET /api/v1/admin/classes
GET /api/v1/admin/classes/{class_id}/students
GET /api/v1/admin/risk-students?risk_level=red
GET /api/v1/admin/risk-students/export?risk_level=red&from=&to=
GET /api/v1/admin/export?from=&to=&format=csv
```

当前管理员统计接口需要 `school_admin` 或 `admin`，高风险学生列表还允许 `doctor` 查看。总览返回学生数、设备数、在线设备数、平均标准坐姿率、高风险提示人数和班级摘要。导出支持 `format=csv` 和 `format=xlsx`，只导出匿名坐姿记录，不包含设备 Token、学生姓名、手机号或真实班级信息。

风险学生记录导出接口返回 zip 文件。zip 解压后，每个文件是一个学生的 Excel 表格，文件名为 `{student_id}_{download_timestamp}.xlsx`，表格中只包含该学生的非正常坐姿记录。

### 小程序通知接口

```text
GET  /api/v1/notifications?unread_only=false
POST /api/v1/notifications
POST /api/v1/notifications/{notification_id}/read
```

家长能看到发给自己的通知、发给自己关联学生的通知和全局通知。管理员/校医可查看全部通知。创建通知需要 `school_admin` 或 `admin`。

## 运行后端

在项目根目录或 `backend/` 目录均可运行。

首次安装依赖：

```powershell
cd D:\桌面整合\2026春\竞赛\物联网\SG\backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

启动后端：

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API 文档：

```text
http://127.0.0.1:8000/docs
```

## 运行测试

从项目根目录运行：

```powershell
backend\.venv\Scripts\python.exe -m pytest
```

或从 `backend/` 目录运行：

```powershell
.\.venv\Scripts\python.exe -m pytest
```

测试会使用：

```text
backend/test_spineguard.db
```

测试会清空并重建测试数据库，不会影响正式开发数据库 `backend/spineguard.db`。

## 查看数据库

### Navicat

1. 新建连接，选择 SQLite。
2. 数据库文件选择：

```text
D:\桌面整合\2026春\竞赛\物联网\SG\backend\spineguard.db
```

3. 展开 `main`。
4. 打开 `Tables`，查看 `users`、`posture_records` 等表。

### 命令行

在项目根目录运行：

```powershell
backend\.venv\Scripts\python.exe -c "import sqlite3; con=sqlite3.connect('backend/spineguard.db'); print(con.execute(\"select name from sqlite_master where type='table'\").fetchall()); print(con.execute('select user_id, username, role from users').fetchall()); con.close()"
```

## 下一步建议

建议后端下一阶段优先实现：

1. 设备离线状态定时更新
2. 通知自动生成策略
3. 更细的统计图表专用聚合接口
4. LLM 报告模板和提示词版本管理
5. 数据库迁移工具，例如 Alembic

完成这些后，Web 和小程序就可以从“账号 + 设备绑定”继续推进到趋势图、风险提示和报告中心。
