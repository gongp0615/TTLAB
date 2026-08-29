# TTLAB Agent 集成设计（DeepSeek Harness）

## 1. 目标与范围

TTLAB 接入 DeepSeek Harness（dsh）作为集中运维助手，使操作人员可以通过自然语言完成设备管理、日志查看和故障处理：

- **管理设备**：查看 Client/设备状态、下发串口操作、触发 Client 升级。
- **查看日志**：按设备、时间、关键字检索设备日志、事件、指令和审计记录。
- **处理报错**：收到故障后自动检索相关日志、分析原因、给出处置建议，并在用户授权后执行修复指令。
- **协助工作**：以对话方式完成日常巡检、排障和状态汇报。

本设计遵守 `PROJECT_RULES.md` 第 2 节模块边界：

- Agent 永不直接连接 Client 或串口设备，只通过 Server 能力接口操作。
- Web 控制台只通过 Server API/WebSocket 与系统交互。
- Agent 的所有写操作走权限检查、审批和审计。

设计决策（2026-08-29 确认）：

- Agent 以独立服务运行于 Server 宿主机。
- 模型接入使用 DeepSeek API。
- 交互入口同时实现 Web 控制台内嵌聊天面板与 dsh 自带 Web/TUI。
- 暂不引入数据库，日志与审计使用文件持久化（logstore）。

## 2. 总体架构

```text
用户浏览器 (Web 控制台 + 聊天面板)          dsh Web/TUI (独立界面)
     │                                        │
     │ WSS /api/v1/agent/session              │ MCP client
     ▼                                        ▼
Server 总控制台 ───────────────────────────► dsh Agent 服务 (独立进程)
  ├ 认证 / 权限 / 审批                         │  LLM = DeepSeek API
  ├ 设备管理 / 指令调度                        │  通用工具 (受限)
  ├ 文件日志存储 logstore ◄──────────────┐     │
  ├ TTLAB MCP Server (工具暴露)───────────────┘
  └ Agent 网关 (聊天代理、会话、审批)
     │
     ▼
Linux Client ... (仅经 Server 通信，协议不变)
```

核心原则：**TTLAB MCP Server 是唯一的 Agent 工具出口**。无论用户从 dsh Web/TUI 还是 TTLAB 聊天面板发起，Agent 的工具调用最终都落在同一个 MCP Server 上，复用同一套权限、审批和审计。

## 3. 组件设计

### 3.1 dsh Agent 服务

- 独立进程，systemd 管理（`ttlab-agent.service`），运行于 Server 宿主机。
- 配置 DeepSeek API Key 与模型（`deepseek-chat` / `deepseek-reasoner`）。
- 双模式：
  - **Web/TUI 模式**：直接使用 dsh 自带界面，配置 TTLAB MCP Server 为 MCP client。
  - **Headless 模式**：由 Server Agent 网关驱动，供 Web 聊天面板使用。
- 通用工具（shell/file 等）默认关闭或限定工作目录，以 TTLAB 工具为主。

### 3.2 TTLAB MCP Server

随 Server 进程部署，通过 HTTP 端点 `/mcp/v1`（Streamable HTTP，JSON-RPC 2.0）暴露 TTLAB 内部能力。dsh 作为 MCP 客户端连接。已实现工具：

| 工具 | 能力 | 风险 |
| --- | --- | --- |
| `client_list` | Client 状态 | 只读 |
| `device_list` | 设备与端口 | 只读 |
| `device_status` | 设备详情 | 只读 |
| `log_query` | 日志/事件/指令/审计检索 | 只读 |
| `audit_query` | 审计查询 | 只读 |
| `command_status` | 指令状态 | 只读 |
| `command_execute` | 下发指令 | 写（`reboot`/`reset` 需审批，审批流接入前直接拒绝） |
| `client_update` | 触发升级 | 写（审批流接入前直接拒绝） |

只读工具直接放行；写工具按风险执行或返回 `APPROVAL_REQUIRED`。聊天面板内的 Agent 会话（网关）对高风险写操作走审批流；通过 MCP 端点直接调用的高风险操作仍返回 `APPROVAL_REQUIRED`（由 dsh 侧权限系统承担确认，待现场验证后放开）。

端点行为：

- 功能总开关 `TTLAB_AGENT_ENABLED=1`；未开启返回 404。
- 仅接受 `POST`，其他方法返回 405。
- 配置 `TTLAB_AGENT_TOKEN` 后要求 `Authorization: Bearer <token>`，否则返回 401。
- 客户端 `Accept: text/event-stream` 时以 SSE 帧返回，否则返回 JSON。
- 通知类消息（如 `notifications/initialized`）返回 202 空响应。
- 会话握手：`initialize` 之后即可调用 `tools/list`、`tools/call`。

### 3.3 Server Agent 网关

已实现（`apps/server/src/agent-gateway/`）：

- WebSocket `/api/v1/agent/session`：每个连接一个会话，全局并发上限 `TTLAB_AGENT_MAX_SESSIONS`。
- 引擎采用 `server-native` 实现（`AgentEngineAdapter` 的当前实现）：Server 直接调用 DeepSeek 兼容 API，复用 MCP 工具定义执行工具调用。
- 消息类型见 5.2；会话记录落盘（`agent/` 日志），审批与指令下发写入审计。
- 审批拦截：高风险写操作暂停 Agent 循环，向面板推送 `agent.approval.request`，超时（`TTLAB_AGENT_APPROVAL_TIMEOUT_MS`）自动拒绝。
- `dsh-headless` 引擎作为后续增强，接口与 `server-native` 对齐，工具与审批逻辑复用。

### 3.4 文件日志存储 logstore

Server 内新增模块 `apps/server/src/logstore/`，负责设备日志、事件、指令、审计和 Agent 会话的结构化文件持久化。详见第 6 节。

### 3.5 Web 聊天面板

已实现：

- `index.html`/`app.js`/`styles.css` 增加可折叠聊天面板与悬浮入口。
- 支持对话、工具调用状态卡片、审批确认按钮、会话状态与断线重连。
- 完整处理加载中、空数据、网络断开、Server 错误、审批超时等状态。

## 4. 权限与审批模型

- 当前无 Web 用户认证，会话按连接隔离；`actor` 记录为 `agent:<sessionId>`，Web 用户认证落地后替换为真实用户。
- **只读工具**：直接放行，全量审计。
- **写工具**：低风险操作（`ping`/`status`/`switch`）执行前审计；高风险操作（`reboot`/`reset`/升级）必须审批：
  1. Agent 调用高风险工具时，网关暂停循环并生成 `agent.approval.request`（目标、操作、参数、理由）。
  2. Web 面板弹出确认卡片，超时（默认 60s）自动拒绝。
  3. 确认后以 `agent:<sessionId>` 记录审计并执行；拒绝/超时结果回传 Agent，由其调整方案。
- 审批决策、指令下发与 Agent 会话均写入审计/会话日志，保证可追溯。

## 5. 协议与接口

Client 侧协议零改动。Server 新增能力如下。

### 5.1 新增 REST API

```text
GET  /api/v1/logs/query        日志/事件/指令查询
GET  /api/v1/audit             审计记录查询
GET  /api/v1/settings/agent    Agent 设置读取（密钥掩码返回）
PUT  /api/v1/settings/agent    Agent 设置更新（运行时生效，写入 server.env）
POST /mcp/v1                   MCP 端点（dsh 接入）
WS   /api/v1/agent/session     Agent 会话通道（聊天面板）
GET  /api/v1/agent/sessions    Agent 会话列表（后续）
GET  /api/v1/agent/sessions/:id/messages（后续）
POST /api/v1/agent/approvals/:id   审批确认/拒绝（后续）
```

`/api/v1/logs/query` 查询参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `type` | 可重复，`device`/`event`/`command`/`audit`/`agent` | `device` |
| `clientId` | 精确匹配 | - |
| `deviceId` | 精确匹配 | - |
| `commandId` | 精确匹配 | - |
| `actor` | 精确匹配（审计） | - |
| `from` / `to` | ISO 8601 UTC 时间范围 | 最近 24 小时 |
| `keyword` | 大小写不敏感子串匹配 | - |
| `limit` | 1..1000 | 100 |
| `offset` | 0..100000 | 0 |

响应：`{ data, hasMore, nextOffset, truncated }`。`truncated=true` 表示扫描字节预算耗尽，返回结果可能缺失最早部分数据。

`/api/v1/audit` 复用 `/api/v1/logs/query` 参数，强制 `type=audit`。

### 5.2 Agent 网关 WebSocket 协议

浏览器连接到 `ws://<server>/api/v1/agent/session` 即建立会话，Server 下发 `agent.session.ready`（含 `sessionId`）。

客户端 → 服务端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `agent.message.submit` | `content` | 提交用户消息 |
| `agent.approval.response` | `approvalId`、`decision`（`approved`/`rejected`） | 审批确认/拒绝 |

服务端 → 客户端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `agent.session.ready` | `sessionId` | 会话建立 |
| `agent.session.status` | `status`（`idle`/`thinking`/`awaiting_approval`/`error`） | 会话状态 |
| `agent.message.delta` | `delta` | 助手回复文本（当前为非流式，单次发送完整文本） |
| `agent.message.done` | - | 本轮结束 |
| `agent.tool.status` | `tool`、`toolStatus`（`running`/`done`/`error`）、`args`、`result` | 工具调用状态 |
| `agent.approval.request` | `approvalId`、`tool`、`args`、`reason`、`expiresAt` | 高风险操作审批请求 |
| `agent.error` | `code`、`message` | 错误 |

示例（提交消息）：

```json
{ "type": "agent.message.submit", "sessionId": "session_01J...", "content": "为什么 TVB-02 报错？" }
```

审批消息：

```json
{
  "type": "agent.approval.request",
  "approvalId": "apr_01J...",
  "tool": "command_execute",
  "clientId": "client-001",
  "deviceId": "tvbox:...",
  "operation": "device.reboot",
  "parameters": {},
  "reason": "修复日志中的异常状态",
  "expiresAt": "2026-08-29T10:01:00Z"
}
```

### 5.3 MCP 工具定义

工具清单与端点行为见 3.2。实现说明：

- `log_query`、`audit_query` 直接调用 logstore 查询模块，入参校验规则与 REST API 一致。
- `command_execute` 与 REST 指令下发共用同一 `dispatchCommand` 实现（设备/操作/参数校验、指令创建、审计、下发）。
- 写工具当前对高风险操作返回 `APPROVAL_REQUIRED`，阶段 C 接入审批流后放开。

### 5.4 dsh 接入方式

在安装 dsh 的机器（Server 宿主机）上，将 TTLAB 配置为 dsh 的 MCP 服务器，连接地址：

```text
http://<server-host>/mcp/v1
Authorization: Bearer <TTLAB_AGENT_TOKEN>
```

在 TTLAB Server 侧需要：

```ini
TTLAB_AGENT_ENABLED=1
TTLAB_AGENT_TOKEN=<服务凭据>
```

dsh 侧需要配置 DeepSeek API Key（`TTLAB_DEEPSEEK_API_KEY` 或 dsh 的模型配置），并把 TTLAB MCP 服务器加入 dsh 的 MCP 列表。dsh 的配置格式以其发布版本为准；接入前可用以下命令验证 TTLAB MCP 端点可用：

```bash
curl -X POST http://127.0.0.1/mcp/v1 \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <TTLAB_AGENT_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

工具调用示例（查询设备日志）：

```bash
curl -X POST http://127.0.0.1/mcp/v1 \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <TTLAB_AGENT_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"log_query","arguments":{"types":["device"],"keyword":"error"}}}'
```

若 dsh 仅支持 stdio 形式接入 MCP 服务器，需增加一个 stdio 桥接进程（转发到 `/mcp/v1`），属于后续增强。

## 6. 数据模型

### 6.1 LogEntry

所有日志行统一使用 JSON Lines，单行一个对象：

```json
{
  "ts": "2026-08-29T10:00:00.000Z",
  "type": "device",
  "clientId": "client-001",
  "deviceId": "tvbox:...",
  "commandId": "cmd_01J...",
  "actor": "anonymous",
  "sessionId": "session_01J...",
  "data": {}
}
```

- `ts`：事件时间（UTC ISO 8601），全部按 UTC 存储。
- `type`：`device`/`event`/`command`/`audit`/`agent`。
- `data`：类型相关结构化字段。
- 可选字段按需出现；时间在索引层按 UTC 日期分片。

### 6.2 文件布局

```text
<TTLAB_LOG_DIR>/
  device/YYYY-MM-DD/<clientId>.jsonl   设备日志流
  event/YYYY-MM-DD.jsonl               设备/Client 事件
  command/YYYY-MM-DD.jsonl             指令生命周期
  audit/YYYY-MM-DD.jsonl               用户/Agent 操作审计
  agent/YYYY-MM-DD/<sessionId>.jsonl   Agent 会话与工具调用
```

- 追加写、按天轮转。
- 文件名使用安全字符集；非法字符替换为 `_`。
- 保留期默认 30 天（`TTLAB_LOG_RETENTION_DAYS`），启动与每日定时清理过期文件。
- 高频设备日志使用批量缓冲 + 定时 flush（默认 500ms，`TTLAB_LOG_FLUSH_MS`），避免拖垮 IO。

### 6.3 写入内容

| 来源 | type | 关键字段 |
| --- | --- | --- |
| `device.log.chunk` | device | deviceId, portId, sequence, data, encoding, truncated |
| Client 连接/离线/心跳超时/上线 | event | action, bootId, version |
| 指令下发与状态变更 | command | operation, parameters, status |
| 命令下发/升级下发（用户操作） | audit | action, operation/version |
| Agent 消息与工具调用 | agent | role, tool, content |

### 6.4 查询语义

- 按 UTC 日期范围扫描对应分片文件，过滤类型/ID/关键字，按 `ts` 升序返回。
- 扫描字节预算默认 64MB（`TTLAB_LOG_MAX_SCAN_BYTES`），超限停止并置 `truncated=true`。
- 查询前先 flush 缓冲，保证未落盘数据可见。
- 不提供精确 total，使用 `hasMore`/`nextOffset` 分页。

## 7. 关键流程

### 7.1 排障会话

1. 用户："TVB-02 日志为什么报错？"
2. Agent 调用 `device_list` 确认设备。
3. Agent 调用 `log_query` 检索最近日志与事件。
4. Agent 分析定位，给出建议。
5. 如需执行修复：Agent 调用 `command_execute` → 网关发起审批 → 用户确认 → 执行 → 结果回传。

### 7.2 异常处理

| 场景 | 处理 |
| --- | --- |
| LLM 超时/断连 | 网关重试并向用户报告错误 |
| 审批超时 | 自动拒绝并回传 Agent |
| 日志写盘失败 | 降级为仅实时转发，记录 logstore 错误并保持服务可用 |
| 并发会话超限 | 返回明确错误码 |
| 文件扫描预算超限 | 返回截断结果并置 `truncated=true` |

## 8. 配置项

Agent 相关设置（启用、模型、API Key、API 地址、Agent Token、并发会话数、审批超时）全部写在项目配置文件 `server.env` 中，是唯一配置来源，不读取环境变量。可在 Web 控制台"系统设置 → Agent / 模型设置"页面运行时修改，保存后**原地改写 `server.env` 中对应键**并即时生效（注释和其他配置保留）。

```text
TTLAB_AGENT_ENABLED=0                     Agent 功能总开关
TTLAB_AGENT_MODEL=deepseek-chat           模型
TTLAB_DEEPSEEK_API_KEY=                    DeepSeek API Key
TTLAB_AGENT_LLM_URL=https://api.deepseek.com   LLM 兼容 API 地址
TTLAB_AGENT_TOKEN=                        dsh 连 MCP 的服务凭据
TTLAB_AGENT_MAX_SESSIONS=8                全局并发会话上限
TTLAB_AGENT_APPROVAL_TIMEOUT_MS=60000     审批超时
TTLAB_LOG_DIR=./data/logs                 日志目录
TTLAB_LOG_RETENTION_DAYS=30               日志保留天数
TTLAB_LOG_FLUSH_MS=500                    日志 flush 间隔
TTLAB_LOG_FLUSH_THRESHOLD_BYTES=262144    单缓冲上限
TTLAB_LOG_MAX_SCAN_BYTES=67108864         单查询扫描字节预算
```

保存密钥后 `server.env` 包含敏感信息（文件权限 0600），成为本机配置，**不应再提交到仓库**；仓库中的 `server.env` 保留空值默认。

## 9. 安全设计

- API Key 与 MCP Token 仅存环境变量/密钥文件，禁止提交仓库。
- dsh Web/TUI 绑定 localhost + 反向代理认证。
- Agent 工具白名单 + 写操作审批 + 全量审计三层兜底。
- 日志与审计不落完整 Token；设备日志敏感内容通过配置脱敏（后续阶段）。
- 审计 `actor` 在当前无用户认证阶段记录为 `anonymous`（REST）或 `agent:<sessionId>`（Agent 会话）；Web 用户认证落地后替换为真实用户标识。

## 10. 测试策略

- **单元测试**：logstore 写入/轮转/清理/查询/分页/关键字/字节预算截断；参数校验；MCP JSON-RPC 解析、initialize/tools/list/tools/call、工具参数校验与高风险操作拒绝；审批管理器、Agent 引擎工具循环与审批拦截。
- **集成测试**：真实 Server 进程下 `device.log.chunk` 落盘、指令生命周期落盘、查询 API 与审计 API；MCP 端点鉴权、SSE 响应、工具全链路；Agent 网关全链路（对话→工具→审批→执行→回复→审计）。
- **异常测试**：非法条目、写失败降级、扫描预算超限、无效查询参数、MCP 未鉴权/未初始化/非法参数、审批超时/拒绝、工具循环上限。
- **后续阶段**：dsh headless 引擎联调、浏览器端到端、多会话与 Web 用户认证。

## 11. 部署与运维

- logstore 随 Server 进程部署，启动自动创建日志目录（`0750`）并按期清理。
- Agent 网关随 Server 进程运行，无需独立服务；接入 dsh 时可选部署 `ttlab-agent.service`，密钥通过 systemd `EnvironmentFile` 注入。
- 日志目录建议独立分区，监控磁盘水位（后续阶段接入告警）。
- 回滚：`TTLAB_AGENT_ENABLED=0` 可整体停用 Agent 能力，logstore 落盘不受影响。

## 12. 分阶段实施

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| A | logstore 文件日志 + 日志/审计查询 API | 已完成 |
| B | TTLAB MCP Server + dsh 接入 | MCP Server 已完成，dsh 实际联调待网络可用 |
| C | Agent 网关（server-native 引擎）+ Web 聊天面板 + 审批流 | 已完成 |
| D | 运维自动化（故障诊断、健康报告、事件订阅监控） | 未开始 |

每个阶段交付前必须同步更新本文档、`project-guide.md` 和测试，并满足 `PROJECT_RULES.md` 交付标准。

## 13. 风险与备选方案

| 风险 | 应对 |
| --- | --- |
| dsh headless 编程接口未验证 | `AgentEngineAdapter` 隔离；`server-native` 引擎已实现并可复用 MCP 工具定义 |
| LLM 非流式响应体验 | 当前单次 delta；后续接入 SSE 流式解析 |
| 高频设备日志落盘 IO | 缓冲批写 + 独立目录 + 字节预算查询 |
| LLM 输出不可控 | 工具白名单 + 审批 + 审计兜底 |
| 文件查询规模增长 | 按天分片 + 扫描预算；后续可迁移 SQLite/PostgreSQL 而不改查询语义 |
