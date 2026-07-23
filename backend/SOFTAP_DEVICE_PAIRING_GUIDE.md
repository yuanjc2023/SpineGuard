# SoftAP 配网与设备绑定后端说明

## 1. 实现目标

硬件首次启动后创建自己的热点。手机连接热点并访问 `http://192.168.4.1`，可以读取设备身份并填写设备要连接的 2.4GHz Wi-Fi、设备名称和后端基础地址。

本次后端修改把“本地配网”和“账号绑定”衔接起来：

- 设备已在后端登记时，校验六位绑定码并立即绑定；
- 设备尚未登记时，保存 10 分钟有效的待处理认领申请；
- 固件联网后调用设备登记接口，后端自动校验并完成设备与学生绑定；
- 绑定完成后下发 `rotate_claim_code` 命令，避免旧绑定码重复使用；
- 同一学生与同一设备在任一时刻都只保留一个有效绑定。

后端不接收、不记录 Wi-Fi SSID 或密码。网络信息只在手机与 `192.168.4.1` 的硬件本地服务之间传输。

## 2. 新增数据表

`device_pairing_requests` 保存短期认领申请：

| 字段 | 含义 |
| --- | --- |
| `pairing_id` | 提供给小程序查询的认领申请编号 |
| `device_id` | 固件基于 MAC 生成的稳定设备编号 |
| `student_id` | 准备绑定的学生编号 |
| `requested_by_user_id` | 发起绑定的登录用户 |
| `claim_code_hash` | 六位绑定码的 SHA-256 哈希，不保存明文 |
| `status` | `pending/completed/expired/failed/cancelled` |
| `expires_at` | 默认创建后 10 分钟过期 |
| `binding_id` | 完成后对应的有效绑定记录 |

## 3. 后端接口

以下三个接口都需要用户 JWT：

```text
POST   /api/v1/devices/pair
GET    /api/v1/devices/pairings/{pairing_id}
DELETE /api/v1/devices/pairings/{pairing_id}
```

### 提交认领

```http
POST /api/v1/devices/pair
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "device_id": "SG-A8D738",
  "student_id": "STU-DEMO-001",
  "claim_code": "123456"
}
```

设备尚未登记时：

```json
{
  "ok": true,
  "data": {
    "pairing_id": "PAIR-0123456789AB",
    "device_id": "SG-A8D738",
    "student_id": "STU-DEMO-001",
    "status": "pending",
    "expires_at": "2026-07-23T12:10:00+00:00",
    "completed_at": null,
    "binding": null,
    "message": "Waiting for the device to connect and register"
  }
}
```

设备已登记且绑定码正确时，`status` 直接为 `completed`，同时返回 `binding`。

### 查询进度

```http
GET /api/v1/devices/pairings/PAIR-0123456789AB
Authorization: Bearer <access_token>
```

小程序可每 2 秒查询一次，直到状态不再是 `pending`。超过 10 分钟时返回 `expired`，用户需要重新连接设备热点并读取当前绑定码。

### 取消认领

```http
DELETE /api/v1/devices/pairings/PAIR-0123456789AB
Authorization: Bearer <access_token>
```

只会把尚未完成的申请改为 `cancelled`，不会解除已经生效的绑定。

## 4. 固件登记时的自动完成逻辑

固件完成配网后继续使用已有接口：

```http
POST /api/v1/device/register
X-Device-ID: SG-A8D738
X-Device-Token: <64位设备密钥>
```

后端在保存设备资料后查找同一 `device_id` 的有效认领申请。只有固件登记正文中的 `claim_code` 与申请保存的哈希一致时才完成绑定；不一致的申请保持等待直至过期。

设备登记响应新增两个兼容字段：

```json
{
  "ok": true,
  "device_id": "SG-A8D738",
  "created": true,
  "pairing_status": "completed",
  "pairing_id": "PAIR-0123456789AB"
}
```

没有待处理申请时，两个字段为 `null`，不影响现有固件。

## 5. 小程序调用流程

1. 用户登录小程序并选择要绑定的学生，保留 JWT 和 `student_id`。
2. 小程序引导手机连接 `SpineGuard-<device_id>` 热点。
3. 请求硬件本地 `GET http://192.168.4.1/api/status`，暂存返回的 `device_id` 和 `claim_code`。
4. 在硬件本地页面或小程序配网页面调用 `POST http://192.168.4.1/api/provision`，只把设备名称、Wi-Fi SSID、Wi-Fi 密码和后端基础地址发给硬件。
5. 设备重启联网，手机恢复互联网连接后，小程序调用后端 `POST /api/v1/devices/pair`。
6. 若返回 `completed`，刷新 `GET /api/v1/devices`；若返回 `pending`，每 2 秒调用认领进度接口。
7. 收到 `completed` 后显示绑定成功；收到 `expired` 时提示用户重新连接热点。

如果手机连接硬件热点时仍能通过蜂窝网络访问后端，第 5 步也可以提前到第 4 步之前。后端同时支持这两种时序。

## 6. 安全与权限

- 家长只能把设备绑定给自己账号关联的学生；管理员沿用现有权限规则。
- 后端只保存设备密钥和绑定码的哈希。
- Wi-Fi 密码不得进入业务 API、日志、数据库或 Git。
- 已有其他用户的待处理认领时返回 HTTP 409，避免后来的请求覆盖申请。
- 认领成功会让同一设备和同一学生的旧有效绑定失效，实现换绑覆盖而不是新增多个有效绑定。
- 所有风险结果仍仅用于坐姿行为风险提示或筛查参考，不属于医学诊断。
