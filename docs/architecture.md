# TTLAB 首版本架构设计

## 1. 目标与范围

首版本提供多台 Linux Client 的集中接入、串口设备发现、设备状态展示、远程 AT 操作和 Client 软件更新。

首版本采用无业务持久化的 Server：Server 重启后不恢复旧的运行状态，由 Client 重新连接并发送完整快照。Client 是本机硬件状态的事实来源。

首版本部署边界为单 Server 实例。更新包、TLS 证书和 Server 配置属于部署制品，不属于业务运行状态。

## 2. 模块边界

```text
Web
  -> Server HTTP API / WebSocket
  -> Server 内存态会话、状态缓存和指令调度
  -> Client WSS 连接
  -> Client 串口适配层
  -> TV Stick Test Box / 其他串口设备
```

### Web

- 展示 Server 返回的 Client、串口设备和指令状态。
- 通过 API 发起操作和更新请求。
- 处理加载中、恢复中、离线、超时、权限不足和错误状态。
- 不直接访问串口或 Client 地址。

### Server

- 提供认证、授权、设备查询和指令接口。
- 维护当前连接、Client 快照和设备运行状态。
- 将指令路由到目标 Client，转发进度和结果。
- Server 重启后清空全部运行状态，等待 Client 快照重建。
- 输出结构化运行日志和审计日志，不提供跨重启的历史查询。

### Client

- 持久化 `clientId`、认证凭据和本地更新状态。
- 主动连接 Server，执行注册、心跳、重连和同步。
- 发现串口设备并上报稳定硬件身份。
- 串行执行同一串口上的操作。
- 通过独立 Updater 完成下载、验签、安装、重启和回滚。

## 3. 首版本状态恢复

Server 内存状态只包括当前会话、最新快照、运行中的指令和短期连接信息。

Client 每次建立连接后必须完成以下流程：

1. 发送 `client.hello`。
2. 等待 Server 返回 `sync.request`。
3. 发送完整的 `client.snapshot`。
4. 按 Server 返回的结果开始发送增量状态事件和心跳。

Server 在收到快照前将 Client 标记为 `syncing`，Web 展示“正在恢复”，不得使用过期数据。

Server 重启期间排队中的指令不会自动恢复或重放。已经在 Client 执行的指令由 Client 在快照中报告当前任务和最终结果。

## 4. 可靠性边界

- Server 使用指数退避和随机抖动等待 Client 重连。
- Client 连接断开时停止接受新的远程指令，但可以按策略完成当前串口操作。
- 所有指令有过期时间，过期指令必须拒绝执行。
- 每个串口使用独占执行锁，避免并发读写交叉。
- Client 只执行协议白名单内的操作，不接受任意 shell 命令。
- Server 和 Client 都输出请求 ID、指令 ID、Client ID 和设备 ID，禁止输出完整凭据。

## 5. 安全边界

- 浏览器到 Server 使用 HTTPS/WSS。
- Client 到 Server 使用 WSS，并使用每 Client 独立证书或等效的可撤销凭据。
- Client 凭据支持撤销和轮换，禁止硬编码在程序中。
- 每个设备操作执行 Server 侧 RBAC 检查。
- 重启、DFU、EDID 写入和原始 AT 命令属于高风险操作，需要更高权限和二次确认。

## 6. 后续持久化迁移

Server 业务代码通过 Repository 接口访问 Client、设备和指令状态。首版本使用内存实现，后续可替换为 PostgreSQL 实现。

接入数据库后需要增加历史审计查询、跨重启指令恢复策略、多 Server 协调和高可用部署；这些能力不属于无状态首版本。
