# 开发与验证

## 基础源码检查

使用 Node.js 24.16.0（运行时 SQLite 所需的 Node 24 系列），Windows x64 完整构建另需 Python 3.12、固定 pnpm 和 Windows 构建工具。将仓库克隆到本地磁盘，避免在网络共享盘运行依赖安装和原生构建。

```powershell
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test --workspace @rufa/server
npm run test:integration
node --test apps/client/test/admin-history.test.mjs apps/client/test/admin-center-ui.test.mjs apps/client/test/admin-ipc.test.mjs apps/client/test/security.test.mjs apps/client/test/account-isolation.test.mjs apps/client/test/startup-update.test.mjs
```

`--ignore-scripts` 适合企业层编译/模拟测试；要运行 Electron，还须在构建机显式执行 `node node_modules/electron/install.js`。测试使用合成账号与本机 mock，不需要真实模型 API Key。PostgreSQL 与真实桌面测试有各自环境前置条件，不把跳过视为通过。

## 完整运行与测试

`npm test --workspace @rufa/client` 包含依赖固定 Harness 和离线组件的测试；须先完成 [客户端构建准备](client.md)。设置 `RUFA_RUNTIME_ROOT` 后可运行 `npm run test:history-safety`，这个门禁绑定实际源码、编译文件及 runtime 摘要，不允许复制旧回执绕过。

`tests/desktop-*.test.mjs`、`solidworks-*-live.py` 等属于显式开启的独立实机验收。先阅读文件的环境变量/参数，使用合成账号和独立 profile，确认没有用户任务或未保存模型；不要默认对真实业务文件运行。历史 CAD recipes 是参考资料，不能直接运行其中旧构造器接管已有 SW 窗口。

## 本地迭代

修改前阅读 [接口约定](contract.md)。企业层改造放在 `apps/` 与可重放脚本中，固定上游 checkout 保持干净。修改界面与原生协议时一起构建并在独立 runtime 验证，不能热替换员工正在运行的进程。

`scripts/Start-Dev.ps1` / `Sync-BuildWorkspace.ps1` 是已有本地镜像的复用入口，不负责从零准备完整 runtime。首次构建按文档执行，之后按自己的本地目录设置开发环境。
