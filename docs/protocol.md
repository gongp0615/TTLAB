# TTLAB 首版本通信协议

## 1. 传输方式

- Web API：HTTP REST，路径统一使用 `/api/v1`；启用 TLS 后使用 HTTPS。
- Web 实时事件：Server WebSocket `/api/v1/events`，启用 TLS 后使用 WSS。
- Client 通信：Client 主动建立 WS `/agent/v1/session`，启用 TLS 后使用 WSS。
- 消息编码：UTF-8 JSON。
- 每条消息必须符合版本化 Schema；未知字段必须忽略，未知消息类型返回协议错误。

## 2. 消息信封

```json
{
  "id": "msg_01J...",
  "version": "1.0",
  "type": "client.hello",
  "timestamp": "2026-08-28T10:00:00Z",
  "clientId": "client-001",
  "correlationId": null,
  "payload": {}
}
```

字段要求：

- `id`：全局唯一消息 ID。
- `version`：协议主版本和兼容次版本。
- `type`：消息类型。
- `timestamp`：发送方 UTC 时间。
- `clientId`：Client 消息必填，Server 初始下发消息可从连接上下文取得。
- `correlationId`：响应或进度消息关联原请求。
- `payload`：类型对应的结构化数据。

单条消息限制为 1 MiB。日志、命令输出或其他大数据必须限制长度，后续需要时再增加分片协议。

## 3. 连接和同步消息

### `client.hello`

```json
{
  "clientVersion": "1.0.0",
  "protocolVersion": "1.0",
  "bootId": "boot_01J...",
  "platform": "linux",
  "architecture": "amd64",
  "capabilities": ["serial", "tv-stick-test-box"]
}
```

### `sync.request`

Server 在每次连接建立后发送。Client 必须在同步超时时间内发送完整快照。

### `client.snapshot`

快照必须包含 Client 信息、软件版本、所有当前发现的串口设备、设备状态、正在执行的指令摘要和更新状态。快照带有 Client 本地递增的 `snapshotRevision`，Server 不依赖该值恢复历史，只用于检测同一连接内乱序消息。

### `client.heartbeat`

包含 `bootId`、当前版本、`snapshotRevision` 和健康状态。Server 连续两个心跳周期未收到心跳后将连接标记为离线。

### `device.log.chunk`

Client 从已绑定的日志端口持续发送日志分片：

```json
{
  "deviceId": "tvbox:...",
  "portId": "serial:...if01-port0",
  "sequence": 1024,
  "capturedAt": "2026-08-29T10:00:00.000Z",
  "data": "boot complete\\n",
  "encoding": "utf-8",
  "truncated": false
}
```

单个分片最大 16 KiB，Server 通过 Web 实时事件通道转发；Client 端口拔出后停止发送并在下一次快照中报告端口状态。

## 4. 指令消息

Server 向 Client 发送 `command.execute`：

```json
{
  "commandId": "cmd_01J...",
  "deviceId": "usb:vid-pid-serial",
  "operation": "hdmi.switch",
  "parameters": {"output": "TVA"},
  "issuedAt": "2026-08-28T10:00:00Z",
  "expiresAt": "2026-08-28T10:00:30Z"
}
```

Client 依次返回：

- `command.accepted`
- `command.progress`，可选
- `command.result` 或 `command.failed`

Server 重启后遗失的指令不能自动重放。Client 对过期、未知设备、设备离线、参数非法和串口占用的指令必须返回明确错误码。

## 5. 更新消息

Server 发送 `client.update`：

```json
{
  "updateId": "upd_01J...",
  "version": "1.1.0",
  "downloadUrl": "/agent/v1/releases/1.1.0/linux-amd64.tar.zst",
  "sha256": "...",
  "signature": "...",
  "expiresAt": "2026-08-28T11:00:00Z"
}
```

Client 使用 `update.progress`、`update.completed` 或 `update.failed` 报告结果。更新状态必须能在 Server 重启后通过 Client 重新上报。

## 6. 错误格式

```json
{
  "code": "DEVICE_OFFLINE",
  "message": "target device is offline",
  "retryable": false,
  "details": {}
}
```

错误码至少包括：`UNAUTHORIZED`、`FORBIDDEN`、`INVALID_ARGUMENT`、`CLIENT_OFFLINE`、`DEVICE_OFFLINE`、`SERIAL_BUSY`、`SERIAL_TIMEOUT`、`COMMAND_EXPIRED`、`UPDATE_VERIFY_FAILED`、`UPDATE_ROLLBACK` 和 `PROTOCOL_ERROR`。
