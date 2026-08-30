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
  "capabilities": ["serial", "tv-stick-test-box"],
  "hostname": "device-01",
  "addresses": ["192.168.1.5", "fe80::1"]
}
```

字段说明：

- `hostname`：可选，设备主机名，由 `os.hostname()` 获取。
- `addresses`：可选，设备所有非环回 IP 地址（IPv4 在前），由 `os.networkInterfaces()` 采集。

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

### `system.log`（Server → Web，仅 Web 实时事件通道）

Server 将系统消息以结构化日志条目（LogEntry）推送给所有连接的 Web 控制台，供"系统日志"面板实时展示：

```json
{
  "ts": "2026-08-30T10:00:00.000Z",
  "type": "event",
  "clientId": "client-001",
  "deviceId": "tvbox:...",
  "data": {"action": "device.discovered", "status": "identified"}
}
```

- `type` 为 `event` 时，`data.action` 取值包括 `client.connected`、`client.online`、`client.disconnected`、`client.heartbeat_timeout`、`client.update.*`、`device.discovered`、`device.removed`、`device.offline`、`device.online`、`server.started`、`server.stopping`。
- `type` 为 `error` 时，`data.code` 为错误码、`data.message` 为错误描述（错误日志为 Server 内部日志类别，可经 `GET /api/v1/logs/query?type=error` 查询）。
- 该信封仅由 Server 发送给 Web 控制台；Client 会话协议不接收此类型，`parseEnvelope` 会将其判为协议错误。

Web 控制台实时接收 `system.log`，历史数据通过 `GET /api/v1/logs/query?type=event&type=error&limit=200` 拉取。

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

固件刷写指令（`firmware.flash`）额外携带固件下载引用，二进制固件不经过 WebSocket 消息，Client 通过 `downloadUrl` 下载：

```json
{
  "commandId": "cmd_01J...",
  "deviceId": "tvbox:...",
  "operation": "firmware.flash",
  "parameters": {"version": "V39", "artifact": "Panda_COM-V39-release.bin"},
  "issuedAt": "2026-08-28T10:00:00Z",
  "expiresAt": "2026-08-28T10:10:00Z",
  "firmware": {
    "release": "V39",
    "artifact": "Panda_COM-V39-release.bin",
    "downloadUrl": "/agent/v1/releases/V39/Panda_COM-V39-release.bin?clientId=client-001",
    "sha256": "<64 位 hex>",
    "expiresAt": "2026-08-28T11:00:00Z"
  }
}
```

刷机是分钟级操作，`expiresAt` 为 10 分钟（普通指令 30 秒）。

Client 依次返回：

- `command.accepted`
- `command.progress`，可选
- `command.result` 或 `command.failed`

`command.progress` 用于刷机等长任务的过程反馈：

```json
{
  "commandId": "cmd_01J...",
  "deviceId": "tvbox:...",
  "stage": "flashing",
  "progress": 42,
  "message": "writing flash"
}
```

`stage` 取值：`downloading`、`verifying`、`entering-dfu`、`waiting-for-dfu`、`flashing`、`verifying-flash`、`restarting`、`verifying-firmware`；`progress` 为 0-100 整数。

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

## 5.1 固件管理 API

固件镜像由 Server 统一管理，存储于 `<TTLAB_RELEASE_DIR>/firmware/<version>/`（与 Client 发布包目录 `releases/<version>/` 隔离）。一个固件文件可关联一个或多个设备分类（`deviceTypes`），刷写时目标设备的分类必须命中其中至少一个。

- `POST /api/v1/firmware/releases/:version?artifact=<name>&description=<urlencoded>&deviceType=<type>`：上传固件，body 为原始二进制（`application/octet-stream`）。`deviceType` 可重复传多个值（如 `&deviceType=tv-stick-test-box&deviceType=acme-box`）以关联多个设备分类，未传时默认 `tv-stick-test-box`。已存在返回 409，超限返回 413。
- `GET /api/v1/firmware/releases`：固件列表 `[{version, artifact, sha256, size, deviceTypes, releasedAt, description}]`。
- `GET /api/v1/device-types`：设备分类列表 `[{type, displayName}]`，来源为 `TTLAB_DEVICE_TYPES_DIR`（默认 `<webRoot>/device-types`）下的 `*/device.json`，并合并当前在线 Client 上报的设备分类。
- `GET /agent/v1/releases/:version/:artifact?clientId=<id>`：固件下载，与 Client 发布包下载共用端点，先查 firmware 目录再回退 release 目录；需要 clientId（开启认证时还需 Bearer token）。

固件下载引用由 Server 在 `firmware.flash` 指令中构造，Client 校验 SHA-256 后进入 DFU 刷写。

## 5.2 Web 实时事件订阅

Web 实时事件通道（`/api/v1/events`，见第 1 节）默认只推送 `client.snapshot` 状态消息。`device.log.chunk` 等设备日志消息按订阅转发，避免向未查看日志的 Web 连接广播全部设备日志。

Web 端通过同一 WebSocket 连接发送订阅消息：

```json
{ "type": "log.subscribe", "deviceId": "tvbox:..." }
```

```json
{ "type": "log.unsubscribe", "deviceId": "tvbox:..." }
```

字段要求：

- `deviceId`：要订阅或退订的设备 ID，必须是非空字符串，长度不超过 128，且不含控制字符。
- 订阅目标设备必须存在于任一在线 Client 快照中，否则订阅请求被忽略。
- `log.subscribe` 后，Server 仅向该连接转发该设备的 `device.log.chunk`；`log.unsubscribe` 停止转发。
- Web 连接断开时，Server 自动清除该连接的全部订阅。
- 未知消息类型和其他字段被忽略，保持向后兼容。

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
