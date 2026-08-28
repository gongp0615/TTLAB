# TTLAB 一键部署

## 1. 前置条件

- Linux 主机安装 Node.js 22 或更高版本、npm、systemd 和 `tar`。
- Server 主机和 Client 主机之间可以访问 Server 的 WSS 地址。
- Client 主机安装 `stty`，并存在 `dialout` 用户组。
- 生产环境准备 Client 凭据和 Ed25519 更新公钥。

两个脚本都会执行 `npm ci` 和 `npm run build`，并且必须以 root 运行。

## 2. 部署 Server

在 Server 主机执行：

```bash
sudo -E env \
  TTLAB_VERSION=0.1.0 \
  TTLAB_CLIENT_TOKENS='client-001=replace-with-a-long-random-secret' \
  TTLAB_PUBLIC_BASE_URL='https://ttlab.example.com' \
  ./scripts/deploy-server.sh
```

脚本会：

- 构建 Server 和 Web。
- 安装到 `/opt/ttlab/server/releases/<version>`。
- 原子切换 `/opt/ttlab/server/current`。
- 生成 `/etc/ttlab/server.env`。
- 创建并启动 `ttlab-server.service`。
- 新版本启动失败时恢复上一版本。

检查：

```bash
systemctl status ttlab-server
curl http://127.0.0.1:8080/healthz
journalctl -u ttlab-server -f
```

当前 Server 使用 HTTP/WS，生产环境必须在 Nginx、Caddy 或负载均衡器后配置 HTTPS/WSS。Client 的 `TTLAB_SERVER_URL` 应使用 `wss://`。

## 3. 部署 Client

先把更新公钥放到 Client 主机，例如：

```bash
sudo install -o root -g root -m 0644 update-public.pem /etc/ttlab/update-public.pem
```

再执行：

```bash
sudo -E env \
  TTLAB_VERSION=0.1.0 \
  TTLAB_SERVER_URL='wss://ttlab.example.com/agent/v1/session' \
  TTLAB_CLIENT_ID='client-001' \
  TTLAB_CLIENT_TOKEN='replace-with-the-matching-secret' \
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

Server 的 `TTLAB_CLIENT_TOKENS` 必须包含与 Client 完全一致的 `clientId=token`。首版本无数据库，Server 重启后 Client 会自动重连并重新上报快照。

## 4. 重新部署和回滚

使用新的 `TTLAB_VERSION` 重复执行对应脚本。脚本不会覆盖已有版本目录，启动失败时自动恢复当前版本。

当前版本和最近版本可以通过软链接查看：

```bash
readlink -f /opt/ttlab/server/current
readlink -f /opt/ttlab/client/current
readlink -f /opt/ttlab/updater/current
```
