# Web 本地测试

## Mock 模式

无需后端，直接启动静态服务器：

```bash
cd /Users/nting233/Documents/物联网/web
python3 -m http.server 5173
```

普通 Mock：

```text
http://127.0.0.1:5173/?mode=mock
```

快速游戏测试（推荐）：

```text
http://127.0.0.1:5173/?mode=mock&quick=1
```

家长演示账号为 `parent_demo / parent123`。进入“坐姿种树”后可一键切换六个生长期、任务状态、异常阶段和资源状态。快速入口只在 Mock 模式出现，不会写入正式后端。

`mode` URL 参数只对当前页面生效，不会持久化覆盖配置。也可以在 [config.js](/Users/nting233/Documents/物联网/web/config.js) 中设置 `mode: "mock"` 和 `quickTest: true`。

## API 模式

```bash
cd /Users/nting233/Documents/物联网/SpineGuard/backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

前端默认已使用 API 模式：

```text
http://127.0.0.1:5173/
```

需要临时更换后端时：

```text
http://127.0.0.1:5173/?mode=api&api=http://127.0.0.1:8000/api/v1
```

实时监测连接逻辑：

- 优先连接 `WS /api/v1/ws/students/{student_id}?token=<access_token>`。
- WebSocket 有新遥测时立即更新页面。
- WebSocket 断开后主动重连，同时轮询 `GET /api/v1/students/{student_id}/latest`。
- 轮询失败时从约 2.2 秒逐步退避到 30 秒；WebSocket 正常时每 10 秒用 REST 做一次事实源校准。
- 同一个 `(device_id, session_id, seq)` 只处理一次。测试时必须递增 `seq`，或者更换 `session_id`；否则后端返回 `duplicate: true` 且不广播。

后端已提供乐园状态、任务、资源操作、奖励流水和游戏 WebSocket。专注模式按后端契约使用本地计时器，不请求后端专注会话或结算接口。

浏览器中旧的 `sg.data_mode` 会自动清理。如需恢复默认 API 地址：

```js
localStorage.removeItem("sg.api_base")
```

## 遥测协议契约检查

后端当前上传协议为 V2，历史数据库记录仍可能返回 V1。Web 必须同时兼容两者，并保证 V2 Mock 包含五路 `raw_pressure`：

```bash
cd /Users/nting233/Documents/物联网/web
/opt/homebrew/opt/node@24/bin/node tests/telemetry-contract.test.js
```

当前系统默认的 `/usr/local/bin/node` 版本过旧，不能解析项目已经使用的可选链语法，因此测试显式使用本机 Node 24。测试会直接读取 `../SpineGuard/shared/schema.json` 和 `example.json`，用于尽早发现后端、Web 映射器和 Mock 数据再次发生协议漂移。
