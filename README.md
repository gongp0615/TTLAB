# TTLAB

## 项目设计目标

TTLAB 是一个面向多串口设备的 Web 总控与运维平台。用户通过浏览器访问统一控制台，可以集中查看、管理和操作分布在不同 Linux 设备上的串口设备。

项目主要解决以下问题：

- 串口设备分散在不同 Linux 设备上，缺少统一管理入口。
- 设备在线状态、串口信息和运行情况不易集中查看。
- 设备操作依赖现场登录或独立工具，远程协作效率较低。
- 操作结果、异常信息和运行日志缺少统一记录。

## 系统架构

系统由 Server、Web 控制台和 Client 三部分组成。

```text
用户浏览器
     │
     │ HTTP / WebSocket
     ▼
Server 总控制台
     │
     │ 设备通信协议
     ├──────────────┬──────────────┐
     ▼              ▼              ▼
 Linux Client    Linux Client    Linux Client
     │              │              │
  串口设备       串口设备       串口设备
```

### Server：总控制台

Server 是系统的核心控制中心，负责集中管理、调度和数据展示。

- 提供 Web 页面和接口。
- 管理 Client 连接、身份和注册信息。
- 管理设备、串口、分组和运行状态。
- 接收用户操作请求，并将指令转发给目标 Client。
- 接收 Client 上报的状态、日志和执行结果。
- 为用户提供权限控制、操作记录和异常查看能力。

Server 不直接访问串口硬件，串口相关操作由目标设备上的 Client 执行。

### Web 控制台

Web 控制台是用户使用系统的入口，负责展示 Server 提供的数据和操作能力。

- 查看所有 Client 和串口设备的在线状态。
- 查看设备基本信息、端口信息和运行状态。
- 选择目标设备并发起远程操作。
- 查看指令执行进度、结果和错误信息。
- 查看设备事件和历史操作记录。

当前仓库中的 `index.html`、`styles.css` 和 `app.js` 为 Web 控制台实现，由 Server 静态托管，提供 PC 与手机两套响应式布局：视口 ≤768px 时切换为手机布局（顶栏汉堡按钮 + 左侧抽屉导航、单列内容、Agent 面板全屏），>768px 使用常驻侧边栏的桌面布局。

### Client：Linux 设备端代理

Client 运行在目标 Linux 设备上，是 Server 与实际串口硬件之间的执行节点。

- 随 Linux 系统启动并完成初始化。
- 主动连接 Server 并完成身份注册。
- 维持心跳，支持断线检测和自动重连。
- 扫描并发现本机串口设备。
- 上报串口设备信息、连接状态和运行状态。
- 接收 Server 下发的操作指令。
- 执行串口读写、控制和检测操作。
- 返回执行结果、状态变化和相关日志。

## 核心工作流程

1. Linux 设备启动 Client。
2. Client 初始化本机串口访问能力。
3. Client 连接 Server，并完成注册；Client 认证由 `TTLAB_CLIENT_AUTH_ENABLED` 开关控制。
4. Client 扫描本机串口设备并上报设备信息。
5. Server 保存设备状态，并在 Web 控制台展示。
6. 用户通过 Web 控制台选择设备并发起操作。
7. Server 将操作指令转发给对应 Client。
8. Client 操作串口设备，并实时返回执行状态和结果。
9. Server 记录操作历史、日志和异常信息。

## 设计原则

### 集中管理

所有设备通过一个 Web 控制台统一查看和操作，降低设备维护和远程协作成本。

### 边缘执行

Server 负责管理和调度，Client 负责本地硬件访问，避免 Server 直接依赖设备所在网络或串口环境。

### 自动接入

Client 启动后自动完成连接、注册和设备发现，减少人工配置。

### 可靠通信

通信层需要支持心跳检测、断线重连、请求超时、结果回传和状态同步。

### 安全接入

Server 支持 Client 身份认证和用户权限控制。当前为简化联调流程，Client 认证默认关闭；生产环境恢复认证后，涉及设备控制的操作需要保留完整审计记录。

### 可扩展性

通过统一的设备模型和通信协议，后续可以增加更多串口协议、设备类型、操作指令和 Client 扩展模块。

## 模块边界

| 模块 | 主要职责 |
| --- | --- |
| Web 控制台 | 页面展示、用户操作、状态反馈 |
| Server API | 用户请求、设备管理、权限和操作记录 |
| Server 通信层 | Client 连接、指令路由、状态同步 |
| Client 核心 | 注册、心跳、重连、任务执行 |
| 串口适配层 | 串口发现、打开、读写和关闭 |
| 日志与审计 | 运行日志、错误日志、用户操作记录 |

## 预期能力

- 多 Client 同时在线。
- 一个 Client 管理多个串口设备。
- 自动发现新增或移除的串口设备。
- 实时展示 Client 和设备在线状态。
- 支持远程下发串口操作指令。
- 支持执行超时、失败重试和异常反馈。
- 支持 TV Stick Test Box 固件刷写（Web 上传固件 → Server 调度 → Client 通过 dfu-util 刷写，全程进度与审计）。
- 支持设备、Client 和操作记录查询。
- 支持后续扩展设备分组、用户权限和批量操作。

## 演进阶段

### 阶段一：控制台原型

- 完成 Web 控制台视觉和交互原型。
- 确定设备列表、设备状态和故障信息的展示方式。

### 阶段二：Server 基础能力

- 建立 Client 注册和心跳接口。
- 建立设备信息和状态存储。
- 建立指令下发和结果回传机制。

### 阶段三：Linux Client

- 实现 Client 初始化、注册和自动重连。
- 实现串口设备发现和状态上报。
- 实现基础串口操作能力。

### 阶段四：稳定性与安全

- 增加身份认证、权限控制和传输加密。
- 增加超时、重试、离线恢复和审计能力。
- 增加批量设备管理和可观测性能力。

## 首版本工程实现

首版本采用 TypeScript/Node.js，Server 不持久化业务状态。Server 重启后，Client 会自动重连并重新发送完整快照；因此首版本不提供跨 Server 重启的历史操作查询，也不会自动重放重启前的指令。

设备日志、事件、指令生命周期、错误日志和审计记录通过结构化文件日志（logstore）持久化，可通过 `GET /api/v1/logs/query` 与 `GET /api/v1/audit` 查询历史数据；配置见 `TTLAB_LOG_DIR`。Agent 接入设计见 [docs/agent-integration.md](docs/agent-integration.md)。

当前工程目录：

```text
apps/server       Server HTTP API、Client WSS 会话和内存态状态
apps/client       Linux Client、重连、心跳和串口发现
apps/updater      独立更新器，负责验签、安装、重启和回滚
packages/protocol Server/Client 共享协议类型和消息校验
systemd           Client 和 Updater 服务文件
docs              架构、协议、更新、测试和运维设计
```

### 本地运行

```bash
./scripts/init-environment.sh
source ~/.bashrc
npm install
npm test
npm run build
```

`init-environment.sh` 按用户身份选择 Node 安装方式：普通用户使用 nvm（安装到 `~/.nvm`）；root 用户自动安装系统级 Node.js 22 到 `/usr/local`（适用于云服务器等 root 登录环境）。root 下执行后无需 `source ~/.bashrc`。

脚本同时检查串口访问所需的 `dialout` 组成员资格：普通用户不在该组时会报错并提示修复命令（`sudo usermod -aG dialout $USER` 后重新登录）；root 用户会自动确保 systemd Client 用户 `ttlab` 已加入 `dialout`。只有运行 Client 访问串口才需要该组；`start-server.sh` 会设置 `TTLAB_SKIP_DIALOUT=1` 跳过此检查。**也可以不加入任何组**：执行 `sudo -E ./scripts/install-udev-rules.sh install` 安装 TTLAB udev 规则（仅放宽 TTLAB 设备串口权限为 0666），之后 Client 全程以普通用户运行。

仓库根目录自带默认配置 `server.env`（clone 后可直接使用）。如需调整端口、公网地址或密钥，直接编辑该文件。为避免本机配置被 git 跟踪，建议执行一次：

```bash
git update-index --skip-worktree server.env
```

启动 Server（HTTP/WS，默认读取当前启动目录的 `server.env`）：

```bash
./scripts/start-server.sh
```

启动 Client：

```bash
./scripts/start-client.sh
```

重启 Client（若已部署为 systemd 服务则通过 `systemctl restart ttlab-client`，否则停止并重启前台调试进程）：

```bash
./scripts/restart-client.sh
```

Server 默认使用 HTTP/WS 并监听 `9000`（非特权端口，直接以当前用户运行，无需 root；仅配置 <1024 端口时需 sudo），不需要证书或私钥。TLS/WSS 仍可通过 `TTLAB_TLS_KEY_FILE`、`TTLAB_TLS_CERT_FILE` 和 `TTLAB_TLS_REQUIRED=1` 可选启用。当前默认关闭 Client 认证只适用于受控网络联调；恢复认证时，Server 和 Client 同时设置 `TTLAB_CLIENT_AUTH_ENABLED=1`，并配置匹配的独立凭据。生产部署的 Server systemd 服务以低权用户 `ttlab-server` 运行。

### 一键部署

- Server：参见 [部署文档](docs/deployment.md#2-部署-server) 和 `scripts/deploy-server.sh`。
- Client：参见 [部署文档](docs/deployment.md#3-部署-client) 和 `scripts/deploy-client.sh`。
- 项目总文档：参见 [docs/project-guide.md](docs/project-guide.md)。
- Test Box 接入：参见 [docs/tv-stick-test-box.md](docs/tv-stick-test-box.md)。
