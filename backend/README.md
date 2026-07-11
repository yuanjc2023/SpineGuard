# SpineGuard 后端说明

本目录是 SpineGuard 的 FastAPI 后端。当前阶段已经完成基础目录拆分、SQLite/SQLAlchemy 接入、设备遥测落库和历史查询；账号登录、设备绑定、统计、风险提示和报告接口还在后续阶段实现。

## 当前能力

- 接收 ESP32-S3 或模拟设备上传的遥测数据。
- 使用 Pydantic 校验设备上传字段。
- 使用设备 Token 保护设备上传接口。
- 将设备上传数据写入 `posture_records`。
- 提供设备最新数据和历史数据查询。
- 保留 WebSocket 推送入口。
- 启动时自动创建数据库表。
- 提供独立测试数据库，避免 pytest 清空正式开发数据库。

## 目录结构

```text
backend/
├─ app/
│  ├─ main.py                 FastAPI 应用入口
│  ├─ config.py               API 前缀、版本、Token、数据库路径
│  ├─ db.py                   SQLAlchemy engine/session/init_db
│  ├─ models.py               数据库表模型
│  ├─ schemas.py              设备遥测 Pydantic 模型
│  ├─ state.py                临时内存缓存 latest/history/subscribers
│  ├─ routes/
│  │  ├─ health.py            健康检查接口
│  │  └─ telemetry.py         设备遥测相关接口
│  └─ services/
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
reminder_events
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
- `reminder_events`：提醒事件。

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

当前还没有登录接口，这两个账号目前只用于数据库准备和后续 auth 接口开发。密码以测试哈希形式保存，不保存明文。

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

### 查询设备最新数据

```text
GET /api/v1/devices/{device_id}/latest
```

优先从内存缓存读取；如果后端刚启动且内存为空，会从数据库读取最后一条记录。

### 查询设备历史数据

```text
GET /api/v1/devices/{device_id}/history?limit=100
```

从数据库读取最近记录。`limit` 范围为 `1~2000`。

### WebSocket

```text
WS /api/v1/ws/devices/{device_id}
```

当前用于实时推送设备遥测。第一阶段 Web 和小程序仍可使用轮询。

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

1. `POST /api/v1/auth/login`
2. `POST /api/v1/auth/register`
3. `GET /api/v1/me`
4. 设备注册和设备绑定接口
5. 学生列表和学生详情接口

完成这些后，Web 和小程序就可以从固定设备 Demo 逐步切换到真实账号和设备绑定流程。

