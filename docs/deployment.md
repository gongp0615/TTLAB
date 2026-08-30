# TTLAB 一键部署

## 1. 前置条件

- Linux 主机安装 Node.js 22 或更高版本、npm、systemd 和 `tar`。
- Server 主机和 Client 主机之间可以访问 Server 的 WS 地址；启用 TLS 时使用 WSS。
- Client 主机安装 `stty`，并存在 `dialout` 用户组。
- 生产环境准备 Client 凭据和 Ed25519 更新公钥。

两个脚本都会执行 `npm ci` 和 `npm run build`，并且部署动作必须以 root 运行（写 `/etc/systemd`、创建用户、安装到 `/opt`）。部署完成后，Server 服务以独立低权用户 `ttlab-server` 运行，Client 以 `ttlab` 用户运行，均不要求服务进程保持 root。

新机器可以先在 Linux/WSL 中初始化 Node.js 环境：

```bash
./scripts/init-environment.sh
source ~/.bashrc
```

脚本按用户身份选择安装方式：

- 普通用户：安装 nvm、Node.js 22 和 npm 默认版本到 `~/.nvm`。
- root 用户：自动下载官方预编译二进制包，安装系统级 Node.js 22 到 `/usr/local`（适用于云服务器等 root 登录环境）。此模式安装后无需 `source ~/.bashrc`，因为 `/usr/local/bin` 已在 PATH 中。

普通用户不要使用 `sudo` 运行该初始化脚本（nvm 是 per-user 工具）；root 用户直接运行即可。普通用户如需强制走系统级安装，可设置 `TTLAB_SYSTEM_NODE=1`（配合 `sudo` 使用）。

脚本还会检查串口访问所需的 `dialout` 组：普通用户不在该组时脚本报错并给出修复命令（`sudo usermod -aG dialout $USER` 后重新登录，或 `newgrp dialout` 立即生效）；root 用户会自动把 systemd Client 用户 `ttlab` 加入 `dialout`。只有运行 Client 访问串口才需要该组，纯 Server 部署可忽略（`start-server.sh` 已设置 `TTLAB_SKIP_DIALOUT=1` 自动跳过）。

**替代方案（不加入 dialout 组）**：可以安装 TTLAB 自带 udev 规则，将 TTLAB 设备的串口权限放宽为所有用户可读写（0666），之后 Client 以普通用户运行即可访问串口，无需任何组。一次性安装（需要 root）：

```bash
sudo -E ./scripts/install-udev-rules.sh install   # 安装规则
./scripts/install-udev-rules.sh status            # 查看规则状态与串口权限
sudo -E ./scripts/install-udev-rules.sh remove    # 卸载，恢复 dialout 组方案
```

安装后 `init-environment.sh` 检测到规则存在会跳过 dialout 检查。该规则只匹配 TTLAB 已知设备（GD32 `28e9:018a`、CP2105 `10c4:ea70`），不影响其他外设。

也可以直接使用一键 Server 启动脚本：

```bash
./scripts/start-server.sh
```

该脚本会初始化 Node.js 环境、使用 `npm ci` 重建 Linux 依赖、执行构建并启动 Server。默认监听 `9000` 端口（非特权端口），直接以当前用户运行，无需 sudo；仅当 `server.env` 配置了 <1024 的特权端口时才通过 `sudo` 提权。root 用户直接运行即可（自动使用系统级 Node，不再走 nvm/sudo）。Server 配置从仓库根目录的 `server.env` 读取。

本地调试 Client 使用：

```bash
./scripts/start-client.sh
```

该脚本运行仓库当前构建结果，不安装 systemd 服务、不复制到 `/opt`，日志直接输出到当前终端。默认连接 `ws://127.0.0.1:9000/agent/v1/session`，状态保存到用户目录；可通过 `TTLAB_SERVER_URL`、`TTLAB_SERIAL_DEVICE_TYPE` 和 `TTLAB_STATE_DIR` 覆盖配置。

#### WSL 下 USB 串口自动挂载

在 WSL 中调试时，Windows 主机上的 USB 串口设备必须先用 `usbipd-win` 挂载到 WSL，Client 才能在 `/dev` 下发现串口。`start-client.sh` 启动前会自动检查并挂载：

```bash
./scripts/serial-attach.sh status    # 查看设备分类、usbipd 状态和当前 /dev 串口
./scripts/serial-attach.sh attach    # 挂载命中设备分类的共享串口（需要 Windows 提权）
./scripts/serial-attach.sh check     # 有串口节点则 exit 0，否则 exit 1
```

`attach` 只处理命中 `device-types/*/device.json`（按 `match[].vendorId:productId` 匹配）且处于 `Shared` 状态的 USB 串口设备，非串口外设和未配置类型的串口不会被触碰。未共享的设备默认只提示手动执行 `usbipd bind --busid=<BUSID>`，设置 `TTLAB_WSL_SERIAL_AUTO_BIND=1` 后可自动 bind。

默认行为受以下环境变量控制：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TTLAB_WSL_SERIAL_AUTO_ATTACH` | 1 | `start-client.sh` 是否自动 attach（设为 0 关闭） |
| `TTLAB_DEVICE_TYPES_DIR` | `<仓库>/device-types` | 设备分类目录，attach 匹配依据 |
| `TTLAB_WSL_SERIAL_BUSIDS` | 空（自动识别） | 显式 busid 白名单，设置后只处理指定设备 |
| `TTLAB_WSL_SERIAL_ELEVATE` | 1 | 需要提权时弹 UAC；设为 0 直接调用 usbipd |
| `TTLAB_WSL_SERIAL_AUTO_BIND` | 0 | 对未共享的匹配设备自动 `usbipd bind` |
| `TTLAB_WSL_SERIAL_TIMEOUT_SECONDS` | 30 | Windows 调用超时（秒） |
| `TTLAB_WSL_SERIAL_WAIT_SECONDS` | 10 | attach 后等待串口节点出现的时间（秒） |

真实 Linux 设备（非 WSL）不需要上述步骤，串口设备直接出现在 `/dev` 下。

## 2. 部署 Server

仓库根目录自带默认配置 `server.env`（clone 后可直接使用）。直接编辑它调整本机配置（可含密钥）；部署完成后会随当前版本放在 `/opt/ttlab/server/current/server.env`：

```bash
sudoedit server.env
```

为避免本机配置被 git 跟踪，建议先执行一次：

```bash
git update-index --skip-worktree server.env
```

至少确认以下配置：

```ini
TTLAB_SERVER_PORT=9000
TTLAB_PUBLIC_BASE_URL=http://ttlab.example.com
TTLAB_CLIENT_AUTH_ENABLED=0
```

在项目根目录执行部署：

```bash
sudo ./scripts/deploy-server.sh
```

脚本会：

- 构建 Server 和 Web。
- 安装到 `/opt/ttlab/server/releases/<version>`。
- 原子切换 `/opt/ttlab/server/current`。
- 生成 `/etc/ttlab/server.env` 作为运行配置（`ttlab-server` 用户所有，供系统设置页面回写）。
- 创建低权用户 `ttlab-server` 并启动 `ttlab-server.service`（服务以该用户运行）。
- 新版本启动失败时恢复上一版本。

检查：

```bash
systemctl status ttlab-server
curl http://127.0.0.1:9000/healthz
journalctl -u ttlab-server -f
```

Server 默认以低权用户 `ttlab-server` 运行在 `9000` 端口，使用 HTTP/WS，不要求证书和私钥。运行配置统一保存在 `/etc/ttlab/server.env`，systemd 通过 `EnvironmentFile` 加载。TLS/WSS 作为可选配置，只有同时提供 `TTLAB_TLS_KEY_FILE`、`TTLAB_TLS_CERT_FILE` 并设置 `TTLAB_TLS_REQUIRED=1` 时启用；启用后需确保 `ttlab-server` 用户能读取证书文件。Client 的 `TTLAB_SERVER_URL` 使用 `ws://`；启用 TLS 后改为 `wss://`。

Server 额外配置项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TTLAB_RELEASE_DIR` | `~/.local/state/ttlab-server/releases` | Client 发布包与固件存储根目录；固件位于其 `firmware/<version>/` 子目录。默认取运行用户家目录下的用户状态目录，部署时为 `ttlab-server` 用户、调试时为当前用户，各自可写无需 root |
| `TTLAB_FIRMWARE_MAX_BYTES` | 1048576 (1 MiB) | 固件上传大小上限 |

### 2.1 部署 dsh 引擎（可选）

当 `TTLAB_AGENT_ENABLED=1` 且 `TTLAB_AGENT_ENGINE=dsh` 时，需要额外部署 DeepSeek Harness 常驻服务。`scripts/deploy-server.sh` 在检测到该配置后会自动完成全部部署：

1. 写 `/etc/ttlab/dsh.env`（0600，root）：`DEEPSEEK_API_KEY`（取 `TTLAB_DEEPSEEK_API_KEY`）、`DEEPSEEK_BASE_URL`（取 `TTLAB_AGENT_LLM_URL`）。
2. 向 Server 服务用户安装 dsh web profile（仓库 `deploy/dsh-web-profile/` → `$HOME/.dsh/profiles/web/`）。若设置了 `TTLAB_AGENT_TOKEN`，安装的 `cordis.patch.yml` 会为 TTLAB MCP client 注入 `Authorization: Bearer <token>`。
3. 生成并启用 `ttlab-agent.service`（真实 `dsh` 二进制路径由部署脚本解析，见参考单元 [systemd/ttlab-agent.service](../systemd/ttlab-agent.service)）。

前提：Server 宿主机已安装 dsh：

```bash
# 安装 dsh（在 Server 宿主机，建议使用低权用户运行）
npm install -g @deepseek-ai/dsh
```

dsh web profile 配置（仓库 `deploy/dsh-web-profile/`，安装到 `~/.dsh/profiles/web/`）：

- 挂载 TTLAB MCP：`@deepseek-ai/dsh-mcp-client`，`serverName: ttlab`，`url: http://127.0.0.1:9000/mcp/v1`。
- 挂载 `@deepseek-ai/dsh-tool-ask-user`（可选提问工具，LLM 主动询问操作员时使用）。TTLAB 写操作默认完全授权，无需审批门插件。
- `ttlab-approval-gate.js`：高风险 TTLAB 工具调用（`system.reset`/`device.reboot`/`firmware.flash` 与升级）经 dsh 审批服务转发到 TTLAB 聊天面板确认。

然后在 `/etc/ttlab/server.env` 设置：

```ini
TTLAB_AGENT_ENABLED=1
TTLAB_AGENT_ENGINE=dsh
TTLAB_DEEPSEEK_API_KEY=...
TTLAB_AGENT_TOKEN=...            # 可选，dsh 连 MCP 的凭据
TTLAB_DSH_BASE_URL=http://127.0.0.1:9333
TTLAB_DSH_WORKDIR=./data/agent-work
```

`TTLAB_DSH_WORKDIR` 目录需确保 `ttlab-server` 用户可写。开发环境手动启动可用 `./scripts/start-dsh.sh`（从 `server.env` 读取密钥并注入 `DEEPSEEK_API_KEY`）。dsh 接入的完整设计见 [agent-integration.md](agent-integration.md)。

## 3. 部署 Client

先把更新公钥放到 Client 主机，例如：

```bash
sudo install -o root -g root -m 0644 update-public.pem /etc/ttlab/update-public.pem
```

再执行：

```bash
sudo -E env \
  TTLAB_VERSION=0.1.0 \
  TTLAB_SERVER_URL='ws://ttlab.example.com/agent/v1/session' \
  TTLAB_SERIAL_DEVICE_TYPE='tv-stick-test-box' \
  TTLAB_UPDATE_PUBLIC_KEY_FILE='/etc/ttlab/update-public.pem' \
  ./scripts/deploy-client.sh
```

Client 的 `deploy-client.sh` 会自动安装 `dfu-util`（固件刷写依赖），并将 DFU 设备 VID/PID 写入 `/etc/ttlab/client.env`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TTLAB_DFU_VID` | `28e9` | 设备进入 DFU 模式后的 USB vendor id |
| `TTLAB_DFU_PID` | `018a` | 设备进入 DFU 模式后的 USB product id（实测后可能需调整） |

脚本会：

- 创建 `ttlab` 系统用户并加入 `dialout`。
- 安装 Client 和 Updater 版本目录及启动入口。
- 生成 `/etc/ttlab/client.env` 和 `/etc/ttlab/updater.env`。
- 启用 `ttlab-updater.service` 和 `ttlab-client.service`。
- 配置 Client 开机启动、异常自动拉起和更新后自动重启。

检查：

```bash
systemctl status ttlab-client ttlab-updater
journalctl -u ttlab-client -f
journalctl -u ttlab-updater -f
```

当前部署默认关闭 Client Token 认证。Client 未配置 `TTLAB_CLIENT_ID` 时会自动生成并保存身份；如需启用认证，在 Server 和 Client 部署命令中同时加入 `TTLAB_CLIENT_AUTH_ENABLED=1`，并配置匹配的 `clientId=token`。首版本无数据库，Server 重启后 Client 会自动重连并重新上报快照。Server 服务以低权用户 `ttlab-server` 运行，但仍只建议用于受控网络。

## 4. 重新部署和回滚

使用新的 `TTLAB_VERSION` 重复执行对应脚本。脚本不会覆盖已有版本目录，启动失败时自动恢复当前版本。

当前版本和最近版本可以通过软链接查看：

```bash
readlink -f /opt/ttlab/server/current
readlink -f /opt/ttlab/client/current
readlink -f /opt/ttlab/updater/current
```
