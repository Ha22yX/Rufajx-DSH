# Rufajx-DSH

面向企业员工的 Windows 智能体工作台，基于固定版本的 **DeepSeek Harness**，提供公司账号、集中模型中转、完整会话同步和管理中心。

本仓库是整理后的**源码快照**，包含企业客户端、服务端、工具、测试和构建脚本。它不是已经配置好公司服务的安装包，也不包含公司的账号、密钥、会话或业务文件。公开副本的服务地址使用 `https://dsh.example.com` 占位符。

## 主要功能

- **公司账号与管理中心**：员工/管理员角色、账号生命周期、员工和会话检索、完整历史阅读与用量统计。
- **原生工作台**：保留 Harness 工具与事件语义，支持项目、多文件夹、个人工作偏好和智能体团队。
- **文件与办公**：Office、PDF、OCR，文件修改前快照、历史版本分支、可读差异与恢复。
- **电脑操作**：独立电脑操作子任务、实时桌面进度、Esc 停止、逐工具审查。
- **音视频**：原文件直接解码预览，以及按需加载的 Remotion 视频制作技能。
- **SolidWorks 2016**：查询本机接口、同会话复用独立可见实例、分步骤建模、检查并保留成果窗口；需要用户已安装并授权的 SolidWorks。
- **更新架构**：签名清单、内容寻址更新、稳定启动入口与旧安装器兼容路径。

所有模型请求由公司服务端鉴权和中转；文件、命令、桌面与 CAD 工具在员工电脑执行。管理员阅读会话不会因此获得员工电脑的操作权限。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `apps/client/` | Electron 客户端、界面、企业运行时插件、更新器、安装器 |
| `apps/server/` | Node.js 服务端、SQLite、账号、模型网关、会话与审计 |
| `preinstalled/` | 预装组件锁、电脑进度源码、CAD 工具与参考样例 |
| `scripts/` | 上游准备、可重放补丁、校验、构建与发行工具 |
| `tests/` | 本地模拟集成测试及显式启用的实机测试 |
| `infra/` | 空凭据环境模板、systemd 和可选部署草案 |
| `docs/` | 接口、安全边界、构建和功能说明 |

## 从哪里开始

- [开发与验证](docs/development.md)：依赖安装、编译、模拟测试。
- [服务端部署](docs/server.md)：Node + SQLite、首次管理员、HTTPS、备份。
- [Windows 客户端构建](docs/client.md)：固定上游、全部离线预装、更新信任根、安装包门禁。
- [接口约定](docs/contract.md) · [管理面板](docs/admin-panel.md) · [增量更新](docs/incremental-updates.md)
- [SolidWorks 工具](docs/solidworks-toolkit.md) · [公开范围](docs/public-source.md) · [第三方与许可](THIRD_PARTY_NOTICES.md)

开发基础检查（Node 24.16.0、在本地磁盘工作目录执行）：

```powershell
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test --workspace @rufa/server
npm run test:integration
```

这些命令编译企业层并运行模拟测试，**不会下载全部 Harness/视频运行环境，也不生成可分发客户端**。完整客户端须按构建文档准备固定上游、离线依赖和本机 SolidWorks 接口目录。无硬件/运行时的源码检查不能替代 Windows 实机验收。

## 来源与许可

固定上游为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，精确版本记录在 `upstream.lock.json`。预装来源及摘要由各 lock 文件记录；上游源码通过构建获取，不在本仓库复制整个依赖树。

本次公开未为项目自有代码新增开源许可证；公开可见不代表授予任意商业使用或再分发许可。第三方保留各自许可证，详见 [NOTICE](NOTICE.md) 和 [第三方说明](THIRD_PARTY_NOTICES.md)。Remotion 商业授权、SolidWorks 软件及授权不随仓库提供。
