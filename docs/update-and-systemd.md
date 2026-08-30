# Client 更新与自动启动设计

## 1. 进程组成

```text
ttlab-client.service
  └─ ttlab-client：连接 Server、发现设备、执行指令

ttlab-updater.service
  └─ ttlab-updater：下载、验签、安装、切换和回滚
```

主 Client 不直接覆盖自己的运行文件。Updater 通过受限 Unix Socket 接收更新请求，使用 root 权限完成安装；Client 主进程使用普通专用用户运行。

## 2. 目录布局

```text
/opt/ttlab/client/releases/<version>/
/opt/ttlab/client/current -> /opt/ttlab/client/releases/<version>/
/var/lib/ttlab-client/client-id
/var/lib/ttlab-client/client.json
/var/lib/ttlab-client/updater.json
/var/lib/ttlab-client/credentials/
/var/lib/ttlab-client/update-status.json
```

`client-id`、认证凭据和更新状态是 Client 的必要本地状态，不属于 Server 业务数据库。`client.json`/`updater.json` 是 Client 与 Updater 的配置文件（不使用环境变量），由 `deploy-client.sh` 生成，`ttlab` 用户可读写。

## 3. 更新流程

1. Server 发送带版本、架构、SHA-256、签名和过期时间的更新请求。
2. Client 校验目标版本和当前是否已有更新任务。
3. Updater 通过 HTTPS 下载制品，支持临时文件和中断恢复。
4. 校验签名、Hash、CPU 架构和最低协议版本。
5. 解压到新的版本目录，设置固定属主和权限。
6. 运行新版本 `bin/ttlab-client --check` 自检，失败则删除临时目录并保留旧版本。
7. 原子切换 `current` 软链接。
8. 执行 `systemctl restart ttlab-client.service`。
9. 新版本重新连接 Server 并上报版本和健康状态。
10. 重启失败或健康检查不通过时切换回上一版本并重启。

更新目录保留当前版本和最近一个可回滚版本，清理操作不得影响正在运行的版本。

## 4. systemd 服务

`ttlab-client.service` 必须包含：

```ini
[Unit]
Description=TTLAB Client
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/opt/ttlab/client/current/bin/ttlab-client --config /var/lib/ttlab-client/client.json
Restart=always
RestartSec=5
User=ttlab
Group=ttlab
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

安装时执行 `systemctl daemon-reload`、`systemctl enable` 和 `systemctl start`，升级时只重启服务，不重新依赖人工登录操作。

## 5. 故障处理

- 下载失败：保留旧版本，报告 `UPDATE_DOWNLOAD_FAILED`。
- 验签失败：删除临时包，报告 `UPDATE_VERIFY_FAILED`。
- 磁盘空间不足：不切换版本，报告 `UPDATE_NO_SPACE`。
- 新版本启动失败：自动回滚并报告 `UPDATE_ROLLBACK`。
- Server 重启：Updater 继续运行，完成后 Client 重连并补报最终状态。
- Client 重启：读取本地更新状态，避免重复安装同一版本。
