# TTLAB Agent Instructions

开始任何开发、修改、重构或代码评审前，必须先阅读并遵守：

- [PROJECT_RULES.md](./PROJECT_RULES.md)
- [README.md](./README.md)

`PROJECT_RULES.md` 是 TTLAB 的正式开发规范，规定了系统架构、模块边界、安全、测试、部署和交付要求。

## 基本要求

- 禁止采用 MVP、演示性、临时性或占位式方案。
- 所有实现必须按照完整生产系统标准设计和交付。
- 修改 Server、Client、Web 或通信协议前，必须确认职责边界没有被破坏。
- 任何功能都必须考虑正常流程、异常流程、超时、断线、权限和日志审计。
- 修改接口、数据模型或部署方式时，必须同步更新相关文档和测试。
- 完成工作前必须进行必要的构建、测试和运行验证。
- 所有开发必须在独立 git worktree 中进行，禁止在共享的主工作区直接修改代码；详见 [PROJECT_RULES.md](./PROJECT_RULES.md) 第 12.1 节。

## 项目上下文

TTLAB 是一个通过 Web 集中监控和管理 Linux 串口设备的平台：

- Server 作为总控制台，负责 Web 服务、设备管理、指令调度和审计。
- Client 运行在 Linux 设备上，负责连接注册、串口发现和设备操作。
- Web 控制台只通过 Server API 或 WebSocket 与系统交互，不直接访问串口设备。
