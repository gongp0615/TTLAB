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

脚本会安装并设置 nvm、Node.js 22 和 npm 默认版本。不要使用 `sudo` 运行该初始化脚本。

也可以直接使用一键 Server 启动脚本：

```bash
./scripts/start-server.sh
```

该脚本会初始化 Node.js 环境、使用 `npm ci` 重建 Linux 依赖、执行构建，并使用正确的 Node.js 绝对路径通过 `sudo` 启动 Server。Server 配置从仓库根目录的 `server.env` 读取。

## 2. 部署 Server

项目仓库根目录已经包含 Server 配置文件 `server.env`。clone 后直接编辑；部署完成后会随当前版本放在 `/opt/ttlab/server/current/server.env`：

```bash
sudoedit server.env
```

至少确认以下配置：

```ini
TTLAB_SERVER_PORT=80
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

Server 默认以 root 用户运行在 `80` 端口，使用 HTTP/WS，不要求证书和私钥。运行配置统一保存在 `/opt/ttlab/server/current/server.env`，systemd 通过 `EnvironmentFile` 加载。TLS/WSS 作为可选配置，只有同时提供 `TTLAB_TLS_KEY_FILE`、`TTLAB_TLS_CERT_FILE` 并设置 `TTLAB_TLS_REQUIRED=1` 时启用。Client 的 `TTLAB_SERVER_URL` 使用 `ws://`；启用 TLS 后改为 `wss://`。

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
