# TTLAB 一键部署

## 1. 前置条件

- Linux 主机安装 Node.js 22 或更高版本、npm、systemd 和 `tar`。
- Server 主机和 Client 主机之间可以访问 Server 的 WS 地址；启用 TLS 时使用 WSS。
- Client 主机安装 `stty`，并存在 `dialout` 用户组。
- 生产环境准备 Client 凭据和 Ed25519 更新公钥。

两个脚本都会执行 `npm ci` 和 `npm run build`，并且必须以 root 运行。

新机器可以先在 Linux/WSL 中初始化 Node.js 环境：

```bash
./scripts/init-environment.sh
source ~/.bashrc
```

脚本按用户身份选择安装方式：

- 普通用户：安装 nvm、Node.js 22 和 npm 默认版本到 `~/.nvm`。
- root 用户：自动下载官方预编译二进制包，安装系统级 Node.js 22 到 `/usr/local`（适用于云服务器等 root 登录环境）。此模式安装后无需 `source ~/.bashrc`，因为 `/usr/local/bin` 已在 PATH 中。

普通用户不要使用 `sudo` 运行该初始化脚本（nvm 是 per-user 工具）；root 用户直接运行即可。普通用户如需强制走系统级安装，可设置 `TTLAB_SYSTEM_NODE=1`（配合 `sudo` 使用）。

也可以直接使用一键 Server 启动脚本：

```bash
./scripts/start-server.sh
```

该脚本会初始化 Node.js 环境、使用 `npm ci` 重建 Linux 依赖、执行构建，并使用正确的 Node.js 绝对路径通过 `sudo` 启动 Server。Server 配置从仓库根目录的 `server.env` 读取。

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

`attach` 只处理命中 `device-types/*.json`（按 `match[].vendorId:productId` 匹配）且处于 `Shared` 状态的 USB 串口设备，非串口外设和未配置类型的串口不会被触碰。未共享的设备默认只提示手动执行 `usbipd bind --busid=<BUSID>`，设置 `TTLAB_WSL_SERIAL_AUTO_BIND=1` 后可自动 bind。

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

项目配置模板为仓库根目录的 `server.env.example`。clone 后复制为本机配置 `server.env`（已被 git 忽略，含密钥）；部署完成后会随当前版本放在 `/opt/ttlab/server/current/server.env`：

```bash
cp server.env.example server.env
sudoedit server.env
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
- 使用 `/opt/ttlab/server/current/server.env` 作为运行配置。
- 创建并启动 `ttlab-server.service`。
- 新版本启动失败时恢复上一版本。

检查：

```bash
systemctl status ttlab-server
curl http://127.0.0.1/healthz
journalctl -u ttlab-server -f
```

Server 默认以 root 用户运行在 `9000` 端口，使用 HTTP/WS，不要求证书和私钥。运行配置统一保存在 `/opt/ttlab/server/current/server.env`，systemd 通过 `EnvironmentFile` 加载。TLS/WSS 作为可选配置，只有同时提供 `TTLAB_TLS_KEY_FILE`、`TTLAB_TLS_CERT_FILE` 并设置 `TTLAB_TLS_REQUIRED=1` 时启用。Client 的 `TTLAB_SERVER_URL` 使用 `ws://`；启用 TLS 后改为 `wss://`。

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

当前部署默认关闭 Client Token 认证。Client 未配置 `TTLAB_CLIENT_ID` 时会自动生成并保存身份；如需启用认证，在 Server 和 Client 部署命令中同时加入 `TTLAB_CLIENT_AUTH_ENABLED=1`，并配置匹配的 `clientId=token`。首版本无数据库，Server 重启后 Client 会自动重连并重新上报快照。Server 以 root 运行会扩大进程被攻破后的权限范围，只建议用于受控网络。

## 4. 重新部署和回滚

使用新的 `TTLAB_VERSION` 重复执行对应脚本。脚本不会覆盖已有版本目录，启动失败时自动恢复当前版本。

当前版本和最近版本可以通过软链接查看：

```bash
readlink -f /opt/ttlab/server/current
readlink -f /opt/ttlab/client/current
readlink -f /opt/ttlab/updater/current
```
