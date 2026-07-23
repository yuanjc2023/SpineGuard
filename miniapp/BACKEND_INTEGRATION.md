# 小程序与 FastAPI 后端联调

## 1. 启动后端

```bash
cd ../SpineGuard/backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

当前仓库附带的本地开发数据库包含演示账号、学生、设备和绑定关系：

- 账号：`parent_demo`
- 密码：`parent123`
- 学生：`STU-DEMO-001`
- 设备：`SG-0001`

可设置 `SPINEGUARD_SEED_DEMO=0` 禁用演示数据初始化。

## 2. 上传设备数据

另开终端运行：

```bash
cd ../SpineGuard
python scripts/send_mock_telemetry.py
```

小程序不会自行生成后端遥测。只有 ESP32 或模拟脚本持续上传后，监测页才会出现实时数据。

## 3. 小程序连接地址

微信开发者工具默认使用：

```text
http://127.0.0.1:8000/api/v1
```

真机不能用 `127.0.0.1` 访问电脑。小程序会为真机读取 `miniprogram/config/env.js` 的 `deviceApiBase`。网络变化后应将它改成电脑当前局域网地址，例如：

```text
http://192.168.1.20:8000/api/v1
```

手机与电脑需要处于同一局域网，并允许端口 `8000` 通过防火墙。正式发布时必须改为已备案、加入微信服务器域名白名单的 HTTPS 地址。

## 4. 已接入接口

- 账号登录和 JWT 会话。
- 当前用户的学生、绑定设备上下文。
- 学生/设备最新遥测与历史遥测。
- 每日、每周统计。
- 设备在线状态、电量、固件版本和最后上传时间。
- 报告列表、规则报告和 LLM 智能报告生成。
- 乐园完整状态、游戏规则、任务领取、资源操作和奖励流水。
- 学生遥测 WebSocket 与游戏状态 WebSocket。
- 设备绑定；同一学生同时只保留一个有效设备绑定。
- 专注计时只保存在小程序本地，不请求后端，也不改变奖励。

### 4.1 报告与自动报告通知

- 手动智能报告：`POST /students/{student_id}/reports/generate`，请求体为 `{"report_type":"smart","record_limit":600}`。前端不自行查询 600 条遥测，也不直接调用 LLM。
- 报告列表：`GET /students/{student_id}/reports`，每项使用后端 `report_id` 作为稳定标识。
- 报告详情：`GET /students/{student_id}/reports/{report_id}`。
- 通知列表：`GET /notifications?unread_only=true|false`。admin 可能获得多学生通知，小程序会再按当前 `student_id` 和 `notification_type=report` 过滤。
- 自动报告通知通过 `related_report_id` 与报告 `report_id` 直接关联，不解析标题或日期文本。
- 点击未读自动报告时，先成功读取报告详情，再调用 `POST /notifications/{notification_id}/read`。
- `summary` 中时长字段单位为秒，比例为 0～1；`llm_fallback` 仍作为有效报告展示，但需提示已使用规则兜底。

## 5. 暂未接入或后端尚未提供的能力

- 设备解除绑定：后端只有绑定接口，没有解绑接口。
- 振动强度、提醒间隔、学习模式、勿扰时段等设备控制：后端没有设置下发接口。
- 设备校准、自检、固件升级：后端没有对应接口或设备命令通道。
- 姓名、性别、年级等孩子详细资料：后端学生模型只有匿名编号、学校和班级字段。
- 月度和年度聚合统计：后端当前只有每日和每周统计；小程序只能用有限历史记录近似展示。
- AI 报告已经接入；任意问题多轮对话接口尚未提供，小程序当前根据后端报告摘要在本地回答常见坐姿问题。
- 护脊运动由前端展示，后端不保存完成记录，也不提供运动奖励任务。
- 五点压力协议与固件已经统一为 `left/right/front/back/center` 五个 FSR；真机数据质量仍取决于五个传感器接线与标定是否正确。

## 6. 与后端当前规则一致的运行口径

- 连续正确 5/15/30/45/60 分钟的资源由后端实时发放。
- 基础成长由后端每天北京时间 20:00 结算，当日最多 180 点；前端不自行补发。
- 10 秒无有效遥测时界面显示设备离线，5 分钟后端结束设备学习会话。
- `empty`、`unknown` 和离线暂停设备坐姿计时；专注本地计时器仍继续，除非用户主动暂停。
- 后端任务对象只返回 `task_id/status/progress/target/claimed_at`，标题、单位和奖励文案由小程序按稳定任务代码补全。
# 遥测协议契约测试

后端当前只接受 V2 设备上传，但查询历史数据时会把没有 ADC 原始值的旧记录作为 V1 返回。小程序映射器必须兼容 V1/V2，并要求 V2 提供五路 `raw_pressure`。

```bash
cd /Users/nting233/Documents/物联网/脊小树
/opt/homebrew/opt/node@24/bin/node tests/telemetry-contract.test.js
```

测试直接读取相邻 `SpineGuard/shared/schema.json` 和 `example.json`，并同时检查小程序 Mock 是否仍符合 V2。
