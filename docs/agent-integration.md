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
- Agent 的所有写操作默认完全授权并执行全量审计。

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
  ├ 认证 / 权限 / 审计                         │  LLM = DeepSeek API
  ├ 设备管理 / 指令调度                        │  通用工具 (受限)
  ├ 文件日志存储 logstore ◄──────────────┐     │
  ├ TTLAB MCP Server (工具暴露)───────────────┘
  └ Agent 网关 (聊天代理、会话、审计)
     │
     ▼
Linux Client ... (仅经 Server 通信，协议不变)
```

核心原则：**TTLAB MCP Server 是唯一的 Agent 工具出口**。无论用户从 dsh Web/TUI 还是 TTLAB 聊天面板发起，Agent 的工具调用最终都落在同一个 MCP Server 上，复用同一套权限、审计和写操作完全授权策略。

## 3. 组件设计

### 3.1 dsh Agent 服务

- 独立进程，systemd 管理（`ttlab-agent.service`），运行于 Server 宿主机。
- 通过 `dsh web` 常驻服务（绑定 localhost）暴露本地 API；TTLAB Server 网关作为其 HTTP 客户端驱动会话（见 3.3）。
- 在 dsh web 中配置 DeepSeek API Key 与模型（`deepseek-chat` / `deepseek-reasoner`），并把 TTLAB MCP Server（`/mcp/v1`）加入 dsh 的 MCP 列表。
- 双入口：
  - **Web/TUI 模式**：直接使用 dsh 自带界面，配置 TTLAB MCP Server 为 MCP client。
  - **TTLAB 聊天面板**：TTLAB Server 网关以 `dsh` 引擎驱动 dsh 本地 API，工具、上下文由 dsh 处理。
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
| `command_execute` | 下发指令 | 写（agent 默认完全授权，派发全量审计） |
| `client_update` | 触发升级 | 写（agent 默认完全授权，派发全量审计） |

只读工具直接放行；写工具默认完全授权、直接执行并全量审计。若 dsh 侧的 LLM 主动调用 `ask_user_question` 提问，其 `question/requested` 仍会经网关以审批卡片形式转发到面板，由操作员答复。

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
- 网关通过统一的 `AgentEngine` 适配器驱动两种引擎（`TTLAB_AGENT_ENGINE` 选择）：
  - **`server-native`（默认）**：Server 直接调用 DeepSeek 兼容 API，复用 MCP 工具定义执行工具调用（`ServerNativeEngineAdapter`）。
  - **`dsh`**：网关作为 dsh 本地 API 的 HTTP 客户端（`DshEngine`），把 Web 会话 1:1 映射到 dsh 会话，上下文、工具循环由 dsh 处理。详见 3.6。
- 系统提示词由 `buildSystemPrompt(model)` 在会话建立时动态生成，注入配置中的模型标识，并明确能力边界（仅 TTLAB 平台任务、不得虚构模型/厂商、通信测试须用只读工具验证）。
- 消息类型见 5.2；会话记录落盘（`agent/` 日志），指令下发写入审计。
- 写操作默认完全授权、直接执行；dsh 侧 LLM 若主动发起 `ask_user_question` 提问，仍以审批卡片形式推送面板。

### 3.6 dsh 引擎（DshEngine）

`DshEngine`（`apps/server/src/agent-gateway/dsh-engine.ts`）调用 `dsh web` 的本地 API：

| 网关动作 | dsh 本地 API |
| --- | --- |
| 会话建立 | `POST /api/session.create` `{ sessionId: "ttlab:<key>", cwd }`，同一 `sessionId` 再次调用即恢复同一会话 |
| 提交消息 | `POST /api/session.prompt` `{ sessionId, mode: "queue", content: [{ type: "text", text }] }` |
| 实时事件 | `GET /api/events.mux`（SSE），过滤本会话帧后翻译为网关消息 |
| 提问回传 | `POST /api/respond`（携带 dsh rpcId） |

- **会话映射**：Web 面板连接时通过 `agent.session.open` 上报稳定的窗口标识（浏览器 `sessionStorage` 持久化），网关以 `windowKey ?? gatewaySessionId` 作为 dsh 会话键。同一 Web 窗口断线重连后仍指向同一个 dsh 会话，多轮上下文不丢。
- **事件翻译**：`assistant/message`→`agent.message.delta`；`tool/call`→工具卡片 running；`tool/result`→done/error；`turn/end`→`agent.message.done`；`approval/requested`、`question/requested`→`agent.approval.request`。
- **提问/审批**：dsh 的 `approval/requested` 与 `ask_user_question` 产生的 `question/requested` 都以审批卡片形式推给面板；面板确认后网关按 `approval/requested`（回传 `allowed-once`/`rejected`）或 `question/requested`（选中肯定项 / 取消）构造 `/api/respond` 载荷。TTLAB 写操作不再强制审批，仅当 dsh 侧 LLM 主动发起提问时才出现审批卡片。
- **SSE 容错**：事件流中断自动重连，断流时若存在进行中的轮次则向面板报错并重置状态。

### 3.4 文件日志存储 logstore

Server 内新增模块 `apps/server/src/logstore/`，负责设备日志、事件、指令、审计和 Agent 会话的结构化文件持久化。详见第 6 节。

### 3.5 Web 聊天面板

已实现：

- `index.html`/`app.js`/`styles.css` 增加可折叠聊天面板与悬浮入口。
- 支持对话、工具调用状态卡片、提问/审批确认按钮、会话状态与断线重连。
- 完整处理加载中、空数据、网络断开、Server 错误、提问超时等状态。
- 手机布局（≤768px）下聊天面板以全屏覆盖层呈现，悬浮入口移至右下角。

## 4. 权限与审批模型

- 当前无 Web 用户认证，会话按连接隔离；`actor` 记录为 `agent:<sessionId>`，Web 用户认证落地后替换为真实用户。
- **只读工具**：直接放行，全量审计。
- **写工具**：agent 默认完全授权，`command_execute`/`client_update` 直接执行并全量审计（actor 为 `agent:<sessionId>`）。
- **提问/审批卡片**：不再为高风险操作（`reboot`/`reset`/升级）强制要求操作员审批。仅当 dsh 侧 LLM 主动调用 `ask_user_question` 产生 `question/requested` 时，网关以 `agent.approval.request` 推送到面板；面板答复通过 `/api/respond` 回传 dsh。
- 指令下发与 Agent 会话均写入审计/会话日志，保证可追溯。

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
```

`/api/v1/logs/query` 查询参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `type` | 可重复，`device`/`event`/`command`/`audit`/`agent`/`error` | `device` |
| `clientId` | 精确匹配 | - |
| `deviceId` | 精确匹配 | - |
| `commandId` | 精确匹配 | - |
| `actor` | 精确匹配（审计） | - |
| `from` / `to` | ISO 8601 UTC 时间范围 | 最近 24 小时 |
| `keyword` | 大小写不敏感子串匹配 | - |
| `limit` | 1..1000 | 100 |
| `offset` | 0..100000 | 0 |
| `reverse` | `1`/`true` 时返回窗口内最晚条目，最新在前；`offset` 从最新往回翻页 | 否 |

响应：`{ data, hasMore, nextOffset, truncated }`。`truncated=true` 表示扫描字节预算耗尽，返回结果可能缺失最早部分数据；`reverse=1` 时可能缺失最新部分数据。

`/api/v1/audit` 复用 `/api/v1/logs/query` 参数，强制 `type=audit`。

### 5.2 Agent 网关 WebSocket 协议

浏览器连接到 `ws://<server>/api/v1/agent/session` 即建立会话，Server 下发 `agent.session.ready`（含 `sessionId`）。

客户端 → 服务端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `agent.session.open` | `sessionId` | 连接建立后上报稳定的窗口标识（浏览器 `sessionStorage`），dsh 引擎据此映射会话 |
| `agent.message.submit` | `content` | 提交用户消息 |
| `agent.approval.response` | `approvalId`、`decision`（`approved`/`rejected`） | 提问/审批答复（dsh 侧 LLM 主动发起时） |

服务端 → 客户端：

| 消息 | 字段 | 说明 |
| --- | --- | --- |
| `agent.session.ready` | `sessionId` | 会话建立 |
| `agent.session.status` | `status`（`idle`/`thinking`/`awaiting_approval`/`error`） | 会话状态 |
| `agent.message.delta` | `delta` | 助手回复文本（当前为非流式，单次发送完整文本） |
| `agent.message.done` | - | 本轮结束 |
| `agent.tool.status` | `tool`、`toolStatus`（`running`/`done`/`error`）、`args`、`result` | 工具调用状态 |
| `agent.approval.request` | `approvalId`、`tool`、`args`、`reason`、`expiresAt` | 提问/审批请求（dsh 侧 LLM 主动发起时） |
| `agent.error` | `code`、`message` | 错误 |

示例（提交消息）：

```json
{ "type": "agent.message.submit", "sessionId": "session_01J...", "content": "为什么 TVB-02 报错？" }
```

提问消息（dsh 侧 LLM 通过 `ask_user_question` 主动发起，面板据此答复）：

```json
{
  "type": "agent.approval.request",
  "approvalId": "apr_01J...",
  "tool": "ask_user_question",
  "args": { "question": "确认对 tvbox:... 执行 device.reboot？" },
  "reason": "确认对 tvbox:... 执行 device.reboot？",
  "expiresAt": "2026-08-29T10:01:00Z"
}
```

### 5.3 MCP 工具定义

工具清单与端点行为见 3.2。实现说明：

- `log_query`、`audit_query` 直接调用 logstore 查询模块，入参校验规则与 REST API 一致。
- `command_execute` 与 REST 指令下发共用同一 `dispatchCommand` 实现（设备/操作/参数校验、指令创建、审计、下发）。写操作默认完全授权，MCP 端点直接派发并全量审计。

### 5.4 dsh 接入方式

在安装 dsh 的机器（Server 宿主机）上：

1. 以 `dsh web` 常驻服务启动（绑定 localhost，如 `--port 9333`），systemd 管理。
2. 在 dsh web 中配置 DeepSeek API Key，并把 TTLAB 配置为 dsh 的 MCP 服务器：
   - 连接地址：`http://127.0.0.1:9000/mcp/v1`，`Authorization: Bearer <TTLAB_AGENT_TOKEN>`。
3. 在 web profile 的 `cordis.patch.yml` 中：
   - 挂载 `@deepseek-ai/dsh-mcp-client`（serverName `ttlab`，url 指向 `/mcp/v1`）。
   - 挂载 `@deepseek-ai/dsh-tool-ask-user`（可选提问工具，LLM 主动询问操作员时使用）。
4. TTLAB Server 侧设置：
   - `TTLAB_AGENT_ENABLED=1`、`TTLAB_AGENT_ENGINE=dsh`、`TTLAB_DSH_BASE_URL=http://127.0.0.1:9333`。
5. dsh 的配置格式以其发布版本为准；接入前可用以下命令验证 TTLAB MCP 端点可用：

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
| 设备发现/移除/离线/恢复（快照 diff） | event | action, status, deviceType |
| Server 启动/停止 | event | action, port, tls |
| 指令下发与状态变更 | command | operation, parameters, status |
| 命令下发/升级下发（用户操作） | audit | action, operation/version |
| Agent 消息与工具调用 | agent | role, tool, content |
| 协议错误/派发失败/logstore 写失败/内部异常 | error | code, message, clientId, deviceId |

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
5. 如需执行修复：Agent 调用 `command_execute` → 直接派发 → 审计 → 结果回传。

### 7.2 异常处理

| 场景 | 处理 |
| --- | --- |
| LLM 超时/断连 | 网关重试并向用户报告错误 |
| dsh 提问超时 | 自动取消并回传 Agent |
| 日志写盘失败 | 降级为仅实时转发，记录 logstore 错误并保持服务可用 |
| 并发会话超限 | 返回明确错误码 |
| 文件扫描预算超限 | 返回截断结果并置 `truncated=true` |

## 8. 配置项

Agent 相关设置（启用、模型、API Key、API 地址、Agent Token、并发会话数、提问/审批超时）全部写在项目配置文件 `server.env` 中，是唯一配置来源，不读取环境变量。可在 Web 控制台"系统设置 → Agent / 模型设置"页面运行时修改，保存后**原地改写 `server.env` 中对应键**并即时生效（注释和其他配置保留）。

```text
TTLAB_AGENT_ENABLED=0                     Agent 功能总开关
TTLAB_AGENT_ENGINE=server-native           引擎：server-native（内置直连 LLM）| dsh（DeepSeek Harness）
TTLAB_AGENT_MODEL=deepseek-chat           模型（server-native 使用）
TTLAB_DEEPSEEK_API_KEY=                    DeepSeek API Key
TTLAB_AGENT_LLM_URL=https://api.deepseek.com   LLM 兼容 API 地址
TTLAB_AGENT_TOKEN=                        dsh 连 MCP 的服务凭据
TTLAB_DSH_BASE_URL=http://127.0.0.1:9333  dsh web 本地 API 地址
TTLAB_DSH_WORKDIR=./data/agent-work        dsh 会话工作目录（cwd）
TTLAB_DSH_TOKEN=                          dsh 本地 API 鉴权 Token（可选）
TTLAB_AGENT_MAX_SESSIONS=8                全局并发会话上限
TTLAB_AGENT_APPROVAL_TIMEOUT_MS=60000     dsh 提问/审批超时
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
- Agent 工具白名单 + 写操作全量审计兜底（写操作默认完全授权）。
- 日志与审计不落完整 Token；设备日志敏感内容通过配置脱敏（后续阶段）。
- 审计 `actor` 在当前无用户认证阶段记录为 `anonymous`（REST）或 `agent:<sessionId>`（Agent 会话）；Web 用户认证落地后替换为真实用户标识。

## 10. 测试策略

- **单元测试**：logstore 写入/轮转/清理/查询/分页/关键字/字节预算截断；参数校验；MCP JSON-RPC 解析、initialize/tools/list/tools/call、工具参数校验；Agent 引擎工具循环与写操作直接派发审计。
- **集成测试**：真实 Server 进程下 `device.log.chunk` 落盘、指令生命周期落盘、查询 API 与审计 API；MCP 端点鉴权、SSE 响应、工具全链路；Agent 网关全链路（对话→工具→执行→回复→审计）。
- **异常测试**：非法条目、写失败降级、扫描预算超限、无效查询参数、MCP 未鉴权/未初始化/非法参数、dsh 提问超时、工具循环上限。
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
| C | Agent 网关（server-native 引擎）+ Web 聊天面板 + 写操作审计 | 已完成 |
| D | dsh 引擎（DshEngine）：Web 会话 1:1 映射 dsh 会话、本地 API 驱动、SSE 事件翻译、提问/审批转发 | 已实现，待真实 dsh 环境联调 |
| E | 运维自动化（故障诊断、健康报告、事件订阅监控） | 未开始 |

每个阶段交付前必须同步更新本文档、`project-guide.md` 和测试，并满足 `PROJECT_RULES.md` 交付标准。

## 13. 风险与备选方案

| 风险 | 应对 |
| --- | --- |
| dsh 本地 API 接口版本差异 | `DshEngine` 仅调用稳定公开路由（session.create/prompt/events.mux/respond），并用 mock 服务单测锁定协议 |
| dsh 工具循环对 LLM 主动调用 ask_user_question 的依赖 | 在 MCP 工具描述中明确写操作直接执行并审计；审批卡片统一处理 question/approval 两类帧 |
| LLM 非流式响应体验 | 当前单次 delta；后续接入 SSE 流式解析 |
| 高频设备日志落盘 IO | 缓冲批写 + 独立目录 + 字节预算查询 |
| LLM 输出不可控 | 工具白名单 + 审计兜底 |
| 文件查询规模增长 | 按天分片 + 扫描预算；后续可迁移 SQLite/PostgreSQL 而不改查询语义 |
