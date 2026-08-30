# TTLAB 项目详细说明

## 1. 项目定位

TTLAB 是一个通过 Web 集中监控和管理 Linux 串口设备的平台。

系统将 Web 交互、中心调度和硬件访问分离：

```text
浏览器
  -> Server HTTP API / WebSocket
  -> Linux Client
  -> 串口设备
```

Server 不直接访问串口。Client 运行在串口设备所在的 Linux 主机上，负责硬件发现、串口操作、日志读取和断线重连。

当前版本已经接入第一种设备类型：

```text
tv-stick-test-box
```

## 2. 当前实现状态

当前已经实现：

- Server HTTP API 和 WebSocket 实时事件。
- Client 注册、快照同步、心跳和自动重连。
- `/dev/serial/by-id`、`ttyUSB`、`ttyACM` 串口发现。
- Test Box 硬件特征匹配和多串口聚合。
- GD32 控制口的安全 `AT+PING?` 探测。
- 控制串口 AT 命令执行。
- 非控制串口的日志候选持续读取。
- Web 实时日志展示。
- HDMI 状态查询、HDMI 切换和设备检查操作。
- 同一设备串口命令互斥，不同设备可以并行。
- Client 断线重连、Server 重启后重新同步。
- 设备日志、事件、指令生命周期和审计记录的文件持久化（logstore）与历史查询 API。
- TTLAB MCP Server（`/mcp/v1`）：向 Agent（dsh）暴露设备查询、日志检索、指令下发等工具，写操作默认完全授权并全量审计。
- Agent 网关（`/api/v1/agent/session`）：Web 聊天面板对话、工具调用与写操作审计；引擎可选 `server-native`（直连 DeepSeek 兼容 API）或 `dsh`（委托 DeepSeek Harness 管理上下文与工具调用，Web 会话 1:1 映射 dsh 会话）。
- "系统设置"页面：Agent/模型配置（启用、模型、API Key、API 地址等）运行时修改并原地写入 `server.env`。
- Updater 的 Hash、Ed25519 签名、架构、协议版本、自检和回滚检查。
- 本地调试和 Server/Client 一键启动脚本。

当前仍存在的边界：

- Server 业务状态仍保存在内存中，重启后不会恢复历史数据。
- Server 默认使用 HTTP/WS，Client 认证默认关闭。
- Server 目前没有完整的 Web 用户认证和 RBAC。
- 设备日志已持久化，Agent MCP 端点与 Web 聊天面板已可用；`dsh` 引擎（DshEngine）已实现，真实 dsh 环境已完成联调（本地 `dsh web` + TTLAB 聊天面板通信测试通过），见 [agent-integration.md](agent-integration.md)。
- Test Box 的日志口需要根据真实设备确认，自动识别目前只负责控制口探测。
- 当前配置默认将一个 Client 上发现的同类 Test Box 端点聚合为一个设备；同一 Client 挂载多台相同 Test Box 时，还需要增加按 USB 拓扑或显式绑定的分组配置。

## 3. 仓库结构

```text
apps/server/src/index.ts       Server HTTP、WebSocket、设备状态和指令路由
apps/server/src/logstore/      结构化文件日志存储与查询（device/event/command/audit/agent）
apps/server/src/mcp/           TTLAB MCP Server（JSON-RPC 协议、工具定义、参数校验）
apps/server/src/agent-gateway/ Agent 网关（LLM 客户端、引擎、WebSocket 会话）
apps/client/src/index.ts       Client 连接、同步、命令处理和更新请求
apps/client/src/discovery.ts   串口发现、硬件特征匹配和设备聚合
apps/client/src/device-manager.ts
                               设备刷新、端口角色、绑定和日志采集管理
apps/client/src/serial.ts      串口配置、AT 会话、日志读取和 Test Box 适配器
apps/client/src/executor.ts    设备级串口并发锁
apps/updater/src/index.ts      下载、验签、安装、自检、重启和回滚
packages/protocol/src/index.ts
                               Server/Client 共享消息信封和数据类型
device-types/                  设备类型匹配和能力配置（每设备一个子目录）
device-types/tv-stick-test-box/  TV Stick Test Box 设备配置与固件
device-types/tv-stick-test-box/device.json
systemd/                       Client 和 Updater 服务单元
scripts/                       环境初始化、调试启动和生产部署脚本
docs/                          架构、协议、部署、测试和设备接入文档
tests/                         单元、集成和端到端测试
server.env                     Server 默认运行配置
```

## 4. Server 运行方式

### 4.1 配置文件

Server 从当前启动目录的 `server.env` 读取配置。仓库根目录自带默认 `server.env`（clone 后可直接使用）；按需修改端口、地址和密钥。为避免本机配置被 git 跟踪，建议先执行一次：

```bash
git update-index --skip-worktree server.env
```

`server.env` 默认配置：

```ini
TTLAB_SERVER_PORT=9000
TTLAB_PUBLIC_BASE_URL=http://127.0.0.1:9000
TTLAB_CLIENT_AUTH_ENABLED=0
TTLAB_CLIENT_TOKENS=
# 发布包与固件存储根目录默认取运行用户家目录：~/.local/state/ttlab-server/releases
# TTLAB_RELEASE_DIR=
TTLAB_TLS_REQUIRED=0
TTLAB_TLS_KEY_FILE=
TTLAB_TLS_CERT_FILE=
```

新机器 clone 后只需修改：

```ini
TTLAB_PUBLIC_BASE_URL=http://Server的IP或域名
```

启动脚本（`start-server.sh`/`start-client.sh`/`start-dsh.sh`）在 `server.env` 缺失时自动从 `server.env.example` 复制创建。

`server.env` 只包含本机非敏感默认值；启用认证或保存 Agent 密钥后不要提交该文件。Agent/模型相关键（`TTLAB_AGENT_*`、`TTLAB_DEEPSEEK_API_KEY`）可在 Web 控制台"系统设置 → Agent / 模型设置"页面修改，保存后原地写回 `server.env`；详见 [agent-integration.md](agent-integration.md) 第 8 节。

### 4.2 一键启动

在项目根目录或 `scripts` 目录执行：

```bash
./scripts/start-server.sh
```

脚本会：

1. 检查 Linux/WSL 环境。
2. 初始化或加载 Node.js 环境（普通用户使用 nvm，root 用户使用系统级 Node）。
3. 使用 Node.js 22。
4. 使用 `npm ci` 安装当前平台依赖。
5. 编译 TypeScript。
6. 启动 Server。

Server 前台运行，按 `Ctrl+C` 停止。默认监听 `9000` 端口（非特权端口），直接以当前用户运行，无需 root；仅当 `server.env` 配置了 <1024 的特权端口（如 80）时才通过 `sudo` 提权。

当 `TTLAB_AGENT_ENGINE=dsh` 时，还需单独启动 DeepSeek Harness：

```bash
./scripts/start-dsh.sh
```

脚本从 `server.env` 读取 `TTLAB_DEEPSEEK_API_KEY` 并注入 dsh 的 `DEEPSEEK_API_KEY`，以 `--no-open` 前台常驻在 `TTLAB_DSH_BASE_URL`（默认 `http://127.0.0.1:9333`），按 `Ctrl+C` 停止；若 `server.env` 的引擎非 `dsh`，脚本直接退出。生产部署由 `deploy-server.sh` 自动完成（见 4.3）。

### 4.3 systemd 部署

生产式安装使用：

```bash
sudo ./scripts/deploy-server.sh
```

该脚本读取项目根目录 `server.env`，安装到：

```text
/opt/ttlab/server/releases/<version>
/opt/ttlab/server/current
/etc/ttlab/server.env
/var/log/ttlab-server
/etc/ttlab/dsh.env                       # 仅 TTLAB_AGENT_ENGINE=dsh 时
/etc/systemd/system/ttlab-agent.service  # 仅 TTLAB_AGENT_ENGINE=dsh 时
```

生成的 Server systemd 服务以独立低权用户 `ttlab-server` 运行，并执行：

```text
/opt/ttlab/server/current/dist/apps/server/src/index.js
```

`ttlab-server` 用户由部署脚本幂等创建，用于运行服务、写固件目录（`TTLAB_RELEASE_DIR`）和回写 `/etc/ttlab/server.env`；部署动作本身（写 `/etc/systemd`、创建用户）仍需 root。当 `TTLAB_AGENT_ENABLED=1` 且 `TTLAB_AGENT_ENGINE=dsh` 时，脚本还会把 dsh web profile（仓库 `deploy/dsh-web-profile/`）安装到该用户的 `~/.dsh/profiles/web/`，生成并启用 `ttlab-agent.service`。

检查：

```bash
sudo systemctl status ttlab-server
sudo journalctl -u ttlab-server -f
curl http://127.0.0.1:9000/healthz
```

## 5. Client 运行方式

### 5.1 初始化 Node 环境

新机器在 WSL/Ubuntu 中执行：

```bash
./scripts/init-environment.sh
source ~/.bashrc
```

脚本按用户身份选择安装方式：

- 普通用户：安装 nvm、Node.js 22，并确保使用 Linux 版 `node` 和 `npm`，避免调用 Windows 的 `node.exe` 或 `npm.cmd`。
- root 用户：自动安装系统级 Node.js 22 到 `/usr/local`（官方预编译二进制包），适用于云服务器等 root 登录环境，安装后无需 `source ~/.bashrc`。

普通用户不要使用 `sudo` 运行该脚本；root 用户直接运行即可。

脚本还会检查串口访问所需的 `dialout` 组：普通用户不在该组时脚本报错并给出修复命令（`sudo usermod -aG dialout $USER` 后重新登录，或 `newgrp dialout` 立即生效）；root 用户会自动把 systemd Client 用户 `ttlab` 加入 `dialout`。只有运行 Client 访问串口才需要该组；`start-server.sh` 已设置 `TTLAB_SKIP_DIALOUT=1` 跳过此检查。**也可以改用 udev 规则**（`sudo -E ./scripts/install-udev-rules.sh install`），将 TTLAB 设备串口权限放宽为 0666，之后无需任何组即可访问串口。

### 5.2 调试启动

启动 Server 后，在另一个终端执行：

```bash
./scripts/start-client.sh
```

默认配置：

```text
Server:       ws://127.0.0.1:9000/agent/v1/session
认证:         关闭
状态目录:     ~/.local/state/ttlab-client
串口类型:     自动识别
```

脚本运行当前仓库构建结果，不安装 systemd，不复制到 `/opt`，日志直接输出到当前终端。

可以覆盖 Server 地址：

```bash
TTLAB_SERVER_URL=ws://192.168.1.100/agent/v1/session ./scripts/start-client.sh
```

Client 的实际入口是：

```text
dist/apps/client/src/index.js
```

它是编译后的 JavaScript，不是原生二进制。

### 5.3 生产式 Client 部署

使用：

```bash
sudo ./scripts/deploy-client.sh
```

这个脚本适合测试 systemd 自动启动、串口权限、Updater、安装和回滚。它会把编译结果安装到：

```text
/opt/ttlab/client/releases/<version>
/opt/ttlab/client/current
/opt/ttlab/updater/releases/<version>
/opt/ttlab/updater/current
```

Client systemd 服务以 `ttlab` 用户运行，Updater 以 root 运行。Client 工作目录为 `/opt/ttlab/client/current`，因此可以加载随发布包安装的设备类型配置。

## 6. WSL USB 串口接入

Windows 插入 USB 设备后，WSL 不一定自动拥有设备权限。使用 `usbipd-win`：

在 Windows PowerShell 管理员窗口执行：

```powershell
usbipd list
usbipd bind --busid <BUSID>
usbipd attach --wsl --busid <BUSID>
```

在 WSL 中确认：

```bash
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/
```

Client 用户需要能够读写串口设备。两种方式二选一：

方式一：加入 `dialout` 组：

```bash
sudo usermod -aG dialout "$USER"
```

方式二（推荐，无需加入任何组）：安装 TTLAB udev 规则，将 TTLAB 设备串口权限放宽为 0666：

```bash
sudo -E ./scripts/install-udev-rules.sh install
```

重新打开 WSL 后再运行 Client。设备透传到 WSL 后，Windows 原来的 COM 端口暂时不可用是正常现象。

## 7. 设备识别模型

### 7.1 串口和物理设备的区别

串口是资源，物理 Test Box 是设备。当前 Test Box 的典型结构是：

```text
TV Stick Test Box
├── control       控制串口，发送 AT 命令
├── log           日志串口，持续读取日志
└── dut-debug     DUT 调试串口
```

不能把下面这些动态路径作为设备身份：

```text
/dev/ttyUSB0
/dev/ttyUSB1
/dev/ttyACM0
```

Client 优先使用 `/dev/serial/by-id`，并读取 udev 属性：

```text
ID_VENDOR_ID
ID_MODEL_ID
ID_SERIAL
ID_SERIAL_SHORT
ID_PATH
ID_USB_INTERFACE_NUM
```

### 7.2 Test Box 硬件匹配

设备类型配置位于：

```text
device-types/tv-stick-test-box/device.json
```

当前配置匹配：

```text
GigaDevice GD32 CDC ACM      28e9:018a
Silicon Labs CP2105 Dual UART 10c4:ea70
```

用户现场观察到的典型端口：

```text
/dev/ttyACM0  GD32 CDC ACM
/dev/ttyUSB0  CP2105 if00
/dev/ttyUSB1  CP2105 if01
```

三个端口会聚合成一个 `tv-stick-test-box`。CP2105 的 `if00` 和 `if01` 是两个 UART 通道，不是两个物理 Test Box。

### 7.3 控制口识别

设备配置中的 `probeMatch` 当前只包含 GD32 CDC ACM。Client 启动后仅对这类候选发送：

```text
AT+PING?
```

返回 `PING:` 的串口被绑定为 `control`。CP2105 通道不会发送 AT 命令，避免误操作 DUT 调试口。

控制口识别结果会写入：

```text
<TTLAB_STATE_DIR>/device-bindings.json
```

### 7.4 日志口绑定

在没有明确绑定日志口时，控制口之外的 Test Box 串口会标记为 `log-candidate` 并监听。确认实际日志口后，可以使用稳定 by-id 名称显式绑定：

```bash
TTLAB_TVBOX_LOG_PORT='serial:usb-Silicon_Labs_CP2105_Dual_USB_to_UART_Bridge_Controller_01F02F60-if01-port0' \
./scripts/start-client.sh
```

绑定后：

- 指定端口显示为 `log`。
- 其他未选端口显示为 `dut-debug`。
- Client 只持续读取指定日志口。

日志口具体是 CP2105 的 `if00` 还是 `if01`，需要通过真实设备输出和接线确认；设备手册没有给出这两个接口的角色映射。

## 8. Test Box 控制能力

当前适配器位于：

```text
apps/client/src/serial.ts
```

支持的逻辑操作：

| 操作 | AT 命令 | 说明 |
| --- | --- | --- |
| `system.ping` | `AT+PING?` | 检查设备响应 |
| `system.version` | `AT+VER?` | 查询版本 |
| `hdmi.status` | `AT+HDMI1?` | 查询 HDMI 状态 |
| `hdmi.switch` | `AT+HDMI1=TVA/TVB/ON/OFF` | 切换 HDMI |
| `usb.status` | `AT+USBPATH?` | 查询 USB 路径 |
| `usb.path` | `AT+USBPATH=...` | 切换 USB 路径 |
| `hardware.rgb` | `AT+RGB=DDD` | 设置 RGB |
| `hardware.lcd` | `AT+SYSCMD=LCDOFF/LCDLOGO` | 设置 LCD |
| `system.reset` | `AT+SYSRST=REBOOT/DFU` | 系统重启或 DFU |
| `device.reboot` | `AT+REBOOT=NRM/DWN` | DUT 重启模式 |
| `firmware.flash` | 固件版本 + 文件（DFU 刷写） | 通过 dfu-util 刷写 GD32 固件 |

Server 只接受操作白名单，不接受任意 Shell 或任意原始 AT 命令。

DFU、重启、固件刷写、EDID 写入以及设备配置修改属于高风险操作，当前不应在无权限控制的公网环境开放。

## 9. 日志链路

日志串口使用长期读取会话，控制串口使用单次 AT 请求/响应会话：

```text
日志串口
  -> SerialLogCollector
  -> 16 KiB 分片
  -> device.log.chunk
  -> Server /api/v1/events
  -> Web 实时日志窗口
```

日志消息包含：

```json
{
  "deviceId": "tvbox:...",
  "portId": "serial:...",
  "sequence": 1,
  "capturedAt": "2026-08-29T10:00:00.000Z",
  "data": "boot complete\\n",
  "encoding": "utf-8",
  "truncated": false
}
```

Client 对日志分片限制大小，Server 实时转发，并将分片持久化到 `TTLAB_LOG_DIR`。Server 重启后仍可通过查询 API 检索历史日志。

日志存储布局：

```text
<TTLAB_LOG_DIR>/
  device/YYYY-MM-DD/<clientId>.jsonl   设备日志流
  event/YYYY-MM-DD.jsonl               设备/Client 生命周期事件
  command/YYYY-MM-DD.jsonl             指令生命周期
  audit/YYYY-MM-DD.jsonl               用户/Agent 操作审计
  agent/YYYY-MM-DD/<sessionId>.jsonl   Agent 会话
  error/YYYY-MM-DD.jsonl               错误日志
```

按天轮转、追加写入、批量缓冲定时落盘（`TTLAB_LOG_FLUSH_MS`），保留期由 `TTLAB_LOG_RETENTION_DAYS` 控制。详见 [agent-integration.md](agent-integration.md) 第 6 节。

系统消息（Client 登录/离线、设备发现/离线、错误日志、Server 启动/停止）会实时写入 `event`/`error` 类型日志，并通过 `/api/v1/events` 的 `system.log` 信封推送到 Web 控制台，展示在"设备运行总览"下方的"系统日志"面板。详见 [protocol.md](protocol.md) 第 3 节。

## 10. Server API

当前主要接口：

```text
GET  /healthz
GET  /api/v1/clients
GET  /api/v1/devices
GET  /api/v1/logs/query
GET  /api/v1/audit
GET  /api/v1/settings/agent
PUT  /api/v1/settings/agent
GET  /api/v1/commands/:commandId
POST /api/v1/clients/:clientId/commands
POST /api/v1/clients/:clientId/update
POST /mcp/v1                MCP 端点（Agent/dsh 接入，需 TTLAB_AGENT_ENABLED=1）
WS   /api/v1/agent/session  Agent 聊天会话（需 TTLAB_AGENT_ENABLED=1）
WS   /api/v1/events
WS   /agent/v1/session
GET  /agent/v1/releases/:version/:artifact
```

日志与审计查询示例：

```bash
curl 'http://127.0.0.1/api/v1/logs/query?type=device&clientId=<client-id>&keyword=error'
curl 'http://127.0.0.1/api/v1/logs/query?type=command&commandId=<command-id>'
curl 'http://127.0.0.1/api/v1/logs/query?type=event&type=error&limit=200&reverse=1'
curl 'http://127.0.0.1/api/v1/audit?keyword=command.dispatch'
```

发送 Test Box 检查命令的示例：

```bash
curl -X POST http://127.0.0.1/api/v1/clients/<client-id>/commands \
  -H 'content-type: application/json' \
  -d '{"deviceId":"tvbox:...","operation":"system.ping","parameters":{}}'
```

`deviceId` 应使用 `/api/v1/devices` 返回的聚合 Test Box ID，而不是 `/dev/ttyUSB0`。

## 11. 通信协议

Server 和 Client 共用版本化 JSON Envelope：

```json
{
  "id": "msg_...",
  "version": "1.0",
  "type": "command.execute",
  "timestamp": "2026-08-29T10:00:00.000Z",
  "clientId": "client-...",
  "correlationId": "msg_...",
  "payload": {}
}
```

协议层会校验：

- JSON 格式。
- 消息大小不超过 1 MiB。
- 版本和消息类型。
- 时间戳。
- Client Hello、快照、命令结果和日志分片的基本字段。

Client 快照同时包含兼容用的串口列表和聚合设备列表：

```text
devices        当前串口端口
managedDevices 物理设备和端口角色
```

旧的只上报 `devices` 的 Client 仍可被 Server 兼容处理。

## 12. LAA 关系

`LAA - Intro..pdf` 介绍的是 Linaro Automation Appliance 的整体架构：

```text
LAA = SIB + MIB + DUT
```

TTLAB 当前借鉴 LAA 的资源建模思路：

- 一个物理设备包含多个串口资源。
- 串口资源有明确角色。
- 设备类型决定能力和操作集合。
- Client 作为现场 Linux 执行节点。

LAA 文档没有定义 Test Box 的 AT 协议、USB VID/PID 或串口角色，因此当前没有直接实现 LAVA Worker 或 LAA 控制协议。后续如果需要接入 LAVA，应增加独立的 LAVA 适配层，不应把 LAVA 逻辑写入串口 AT 适配器。

## 13. Updater

Updater 不运行 TypeScript 源码，而是处理签名的 Client 发布包。发布包至少包含：

```text
bin/ttlab-client
dist/
node_modules/
device-types/
```

更新过程：

```text
下载
  -> SHA-256 校验
  -> Ed25519 签名校验
  -> 平台/架构校验
  -> 最低协议版本校验
  -> tar 路径安全检查
  -> bin/ttlab-client --check
  -> 安装新版本
  -> 切换 current
  -> 重启 Client
  -> 健康检查
  -> 失败回滚
```

更新状态保存在：

```text
/var/lib/ttlab-client/update-status.json
```

签名文本格式为：

```text
version\nplatform\narchitecture\nsha256
```

## 14. 测试

运行全部测试：

```bash
npm test
```

当前测试覆盖 107 项：

- 协议 Envelope 和字段校验。
- 日志分片大小和字段校验。
- Test Box 三串口聚合。
- 未绑定控制口时的 `ambiguous` 状态。
- 同设备串口互斥。
- 不同设备并行执行。
- Server/Client 同步和指令回传。
- Client 进程身份持久化和重连。
- Server 断线和重连。
- HTTPS/WSS 配置。
- logstore 写入、轮转、清理、查询、分页、字节预算截断和写失败降级。
- Server 设备日志、指令生命周期和审计落盘与查询 API。
- MCP JSON-RPC 协议、工具列表、参数校验。
- MCP HTTP 端点鉴权、SSE 响应、查询/下发/审计全链路。
- Agent 引擎工具循环与 dsh 提问/审批转发处理。
- Agent 网关全链路（对话→工具→执行→回复→审计）与功能开关。
- 设置存储（配置文件读写、掩码、校验、损坏文件回退）与设置 API 运行时生效。
- Updater 架构、协议版本、签名、Hash、自检和回滚。
- 固件上传/列表/下载端点与 manifest 校验。
- `firmware.flash` 下发（下载引用、过期时间）与 `command.progress` 阶段回传。
- `UsbDfuFlasher` 全流程（mock dfu-util）：SHA-256 校验、DFU 等待、刷写失败重试、回读校验、设备卡 DFU。
- Client 注入 `FakeFirmwareFlasher` 的固件刷写全链路与缺下载引用拒绝。

额外检查：

```bash
node --check app.js
bash -n scripts/*.sh
git diff --check
```

真实硬件验收仍需要在 WSL 透传 Test Box 后执行，重点确认：

1. GD32 CDC ACM 是否返回 `AT+PING?`。
2. CP2105 两个通道中哪个输出 Test Box 日志。
3. 串口波特率是否确实为 `115200 8N1`。
4. HDMI 和 USB 路径操作是否符合实际硬件版本。
5. 拔插设备后端口角色是否正确恢复。

## 15. 故障排查

### Server 启动失败

```bash
sudo ss -ltnp | grep ':9000'
curl http://127.0.0.1:9000/healthz
```

通常原因是 9000 端口已被占用或当前用户没有监听该端口的权限（配置了特权端口时需 sudo 启动）。

### Client 显示 0 个串口

```bash
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/
groups
usbipd list
```

检查 USB 是否附加到 WSL、用户是否属于 `dialout`，以及设备是否使用数据线和正确接口。

### 显示 `generic-serial`

确认 Client 已拉取包含 `device-types/tv-stick-test-box/device.json` 的新版本，并从仓库根目录启动；生产 systemd 版本需要确认 `WorkingDirectory=/opt/ttlab/client/current`。

### 显示 `ambiguous`

说明硬件特征匹配成功，但尚未确认控制口。先检查 Client 日志中的探测结果，或显式设置：

```bash
TTLAB_TVBOX_CONTROL_PORT='serial:usb-...GD32...if00' ./scripts/start-client.sh
```

### 没有实时日志

检查：

- 日志口是否已经透传到 WSL。
- 当前用户是否有串口读权限。
- 日志口是否已经显式绑定。
- Test Box 当前是否真的有日志输出。
- WebSocket `/api/v1/events` 是否连接成功。

## 16. 安全和运行边界

当前简化配置：

```text
Server HTTP/WS（低权用户 ttlab-server 运行）
Client Token 认证关闭
```

只适合本机、实验室或受控内网调试。正式生产环境至少应恢复 Client 认证、启用 HTTPS/WSS、增加 Web 用户认证和 RBAC，并对重启、DFU、EDID 等操作进行二次确认和审计。

## 17. 相关文档

- [项目架构](architecture.md)
- [通信协议](protocol.md)
- [部署说明](deployment.md)
- [更新和 systemd](update-and-systemd.md)
- [测试与运维](test-and-operations.md)
- [Agent 集成设计](agent-integration.md)
- [TV Stick Test Box 接入](tv-stick-test-box.md)
- [TV Stick Test Box 用户手册](../TV-Stick-Test-Box-User-Manual-v02.pdf)
- [LAA 介绍](../LAA%20-%20Intro..pdf)
