# TV Stick Test Box 接入

## 1. 设备模型

Client 会把同一台 Test Box 暴露的多个 USB 串口聚合成一个 `tv-stick-test-box` 设备。每个串口是设备下的端口资源，不再单独作为一个物理设备展示。

当前设备类型配置为 `device-types/tv-stick-test-box/device.json`，匹配：

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

控制口和日志口可以通过稳定设备名明确绑定，在 `client.json` 中配置 `controlSelector` 和 `logSelector`：

```json
{
  "controlSelector": "serial:usb-...if00...",
  "logSelector": "serial:usb-...if01-port0"
}
```

绑定结果保存在 Client 状态目录的 `device-bindings.json`，不会保存动态 `/dev/ttyUSB0` 路径。

## 3. 日志链路

日志端口由 Client 长连接读取，按 16 KiB 上限切分为 `device.log.chunk` 消息，经 Server WebSocket 转发到 Web 控制台的实时日志窗口。日志采集具备串口错误回调和有限消息大小；端口拔出后会随设备快照更新。

## 4. 控制能力

Test Box 支持的操作统一声明在 `device-types/tv-stick-test-box/device.json` 的 `operations` 目录中，每个操作包含显示名、描述、风险级别、AT 命令模板、响应前缀和参数 schema（`enum` 下拉或 `string` 带 pattern 校验）。Client 用它生成 AT 命令，Server 用它做下发前的参数校验，Web 控制台按它动态渲染操作按钮和参数表单。新增操作只需改这一个 JSON。

| 操作 | 参数 | 风险 |
|---|---|---|
| `system.ping` | 无 | low |
| `system.version` | 无 | low |
| `hdmi.status` | 无 | low |
| `hdmi.switch` | `output`: TVA/TVB/ON/OFF | low |
| `usb.status` | 无 | low |
| `usb.path` | `path`: HST2DUT/HST2DSK/DUT2DSK/HST#DUT/ON/OFF | low |
| `hardware.rgb` | `value`: 三位数字 | low |
| `hardware.lcd` | `mode`: LCDOFF/LCDLOGO | low |
| `system.reset` | `mode`: REBOOT/DFU | high |
| `device.reboot` | `mode`: NRM/DWN | high |
| `firmware.flash` | `version` + `artifact`（固件列表） | high |

Web 控制台在设备 `identified` 后显示全部操作按钮：无参操作一键执行；有参操作弹出表单（下拉/输入框按 schema 前端校验）；`risk: high` 的操作执行前二次确认；执行后轮询展示结果。

DFU 复位、设备重启、固件刷写等高风险操作已在目录中标记 `high`，执行前必须二次确认；权限和审批策略仍属后续安全阶段。

固件镜像保存在设备类型子目录 `device-types/tv-stick-test-box/firmware/`（当前为 `Panda_COM-V39-release.bin`，GD32 固件），随 Client 发布包分发。运行时固件由 Web 控制台「固件管理」页上传到 Server 的 `releases/firmware/` 目录，上传时可关联一个或多个设备分类（一个固件文件可对应多类设备）；刷写时经 `/agent/v1/releases/...` 下载到 Client。

### 4.1 固件刷写流程（firmware.flash）

固件刷写由 Client 端可插拔的 `FirmwareFlasher` 执行（默认 `UsbDfuFlasher`，调用 `dfu-util`），完整链路：

```text
Web/Agent 发起 firmware.flash(version, artifact)
  -> Server 校验固件 manifest（SHA-256/设备分类匹配）并构造下载 URL
  -> Client 下载固件 -> SHA-256 校验
  -> 读取旧固件版本（system.version）
  -> AT+SYSRST=DFU 进入 DFU 模式（控制口消失属预期）
  -> 轮询 dfu-util -l 等待 USB DFU 设备重新枚举
  -> dfu-util -D 刷写（失败时同 bin 幂等重试一次）
  -> 可选 dfu-util -U 回读校验
  -> 设备重启，Client 重新发现控制口
  -> 读取新固件版本并比对，随 command.result 返回
```

刷机全程通过 `command.progress` 上报阶段与百分比。设备卡在 DFU 模式时返回 `FLASH_FAILED_DEVICE_IN_DFU`，可拔插 USB 或手动 `dfu-util -D` 恢复。

DFU 模式的 VID:PID 当前默认 `28e9:018a`，可在 `client.json` 的 `dfu` 字段配置（`utilPath`/`vid`/`pid`）。设备进入 DFU 后是否重新枚举为其他 VID:PID、以及 `dfu-util` 的 `-a` 参数组合，需在真实硬件上实测后回填。

## 5. WSL 说明

Windows 连接的 USB 设备必须先通过 `usbipd-win` 附加到 WSL，附加后在 WSL 中应能看到 `/dev/ttyACM*` 或 `/dev/ttyUSB*`，并且运行 Client 的用户属于 `dialout` 组。

推荐使用仓库脚本完成附加。脚本以 `device-types/` 目录为匹配基准，只会附加 VID:PID 命中设备分类（Test Box 为 `28e9:018a` 和 `10c4:ea70`）且处于 `Shared` 状态的设备，不会触碰其他外设：

```bash
./scripts/serial-attach.sh status    # 查看哪些设备命中分类、是否已挂载
./scripts/serial-attach.sh attach    # 挂载匹配的共享串口（需要 Windows 提权，会弹一次 UAC）
./scripts/serial-attach.sh check     # 校验串口节点是否就绪
```

`start-client.sh` 在 WSL 下启动时会自动执行上述检查与附加；用 `TTLAB_WSL_SERIAL_AUTO_ATTACH=0` 可关闭自动附加。也可以指定 busid 精确控制：

```bash
TTLAB_WSL_SERIAL_BUSIDS='2-5 2-6' ./scripts/serial-attach.sh attach
```

当本机 usbipd-win ≥ 4.2 时，`attach` 会带 `--auto-attach --unplugged` 挂载，设备在 Windows 端拔出再插回后会自动重新挂载到 WSL，Client 会自动重新识别；旧版 usbipd-win 拔插后需要重新执行一次 `./scripts/serial-attach.sh attach`。

如果设备只显示为 `ambiguous`，先查看 Client 上报的稳定端口名称，再在 `client.json` 中用 `controlSelector` 和 `logSelector` 做一次绑定。
