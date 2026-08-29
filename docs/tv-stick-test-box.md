# TV Stick Test Box 接入

## 1. 设备模型

Client 会把同一台 Test Box 暴露的多个 USB 串口聚合成一个 `tv-stick-test-box` 设备。每个串口是设备下的端口资源，不再单独作为一个物理设备展示。

当前设备类型配置为 `device-types/tv-stick-test-box.json`，匹配：

- GigaDevice GD32 CDC ACM：`28e9:018a`
- Silicon Labs CP2105 Dual UART：`10c4:ea70`

CP2105 的 `if00` 和 `if01` 是两个 UART 通道。设备识别优先使用 udev 硬件信息和 `/dev/serial/by-id` 稳定名称，不依赖 `ttyUSB0` 等动态路径。

## 2. 端口角色

设备端口角色包括：

- `control`：发送 Test Box AT 命令。
- `log`：持续读取日志。
- `log-candidate`：尚未确认的非控制串口，临时采集日志。
- `dut-debug`：连接 DUT 的调试串口。

启动时 Client 只会对设备类型配置中明确标记为控制口候选的串口发送只读 `AT+PING?`。当前配置只探测 GD32 CDC ACM；CP2105 通道不会发送控制命令，只作为日志候选。

控制口和日志口可以通过稳定设备名明确绑定：

```bash
TTLAB_TVBOX_CONTROL_PORT='serial:usb-...if00...' \
TTLAB_TVBOX_LOG_PORT='serial:usb-...if01-port0' \
./scripts/start-client.sh
```

绑定结果保存在 Client 状态目录的 `device-bindings.json`，不会保存动态 `/dev/ttyUSB0` 路径。

## 3. 日志链路

日志端口由 Client 长连接读取，按 16 KiB 上限切分为 `device.log.chunk` 消息，经 Server WebSocket 转发到 Web 控制台的实时日志窗口。日志采集具备串口错误回调和有限消息大小；端口拔出后会随设备快照更新。

## 4. 控制能力

当前支持的 Test Box 操作包括：

- `system.ping`、`system.version`
- `hdmi.status`、`hdmi.switch`
- `usb.status`、`usb.path`
- `hardware.rgb`、`hardware.lcd`
- `system.reset`、`device.reboot`

EDID 写入、DFU、重启和设备配置类操作仍应增加权限和二次确认后再开放。

## 5. WSL 说明

Windows 连接的 USB 设备必须先通过 `usbipd-win` 附加到 WSL。附加后在 WSL 中应能看到 `/dev/ttyACM*` 或 `/dev/ttyUSB*`，并且运行 Client 的用户属于 `dialout` 组。

如果设备只显示为 `ambiguous`，先查看 Client 上报的稳定端口名称，再用 `TTLAB_TVBOX_CONTROL_PORT` 和 `TTLAB_TVBOX_LOG_PORT` 做一次绑定。
