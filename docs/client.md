# Windows 客户端构建

企业层可以单独编译；完整安装包必须包含固定 Harness、预装插件、Python、媒体与视频环境、CAD 工具和更新器。公开仓库不包含巨大运行时，也不以空文件绕过打包检查。

以下为从当前源码整理的构建流程；本次公开只验证企业层编译与模拟测试，**未从互联网重新构建完整安装包**。依赖下载只在构建机发生，员工登录时不应再安装 npm/Python 包。

## 1. 构建机与企业源码

Windows x64、本地磁盘目录、官方 Node **24.16.0**（旁边保留 LICENSE）、Python 3.12、pnpm **11.28.5**。更新器使用 Windows .NET Framework 的 C# 编译器；重建安装器 DLL 另需 MSVC/Windows SDK 与 7-Zip，参数见对应 PowerShell 脚本。

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run build
```

## 2. 配置自建服务与更新信任根

公开副本固定地址是 `https://dsh.example.com`。发布前将以下位置统一为自己的 HTTPS 服务，再重新编译：

- `apps/client/src/company-config.ts` 的 `COMPANY_SERVER`。
- `apps/client/src/startup-update.ts` 的 `COMPANY_UPDATE_FEED`。
- `apps/client/package.json` 的 `build.publish.url`。
- 准备 runtime 与 `configure-company.mjs` 时传入同一服务来源；相关部署校验测试的占位域名也应同步。

`configure-company.mjs` 只生成兼容配置 JSON，**不能覆盖源码中的固定服务器常量**。用户登录界面不提供任意服务器输入框。

自建发行者另生成 RSA3072 更新密钥，私钥保存到仓库外、仅构建账号可读的目录：

```powershell
node scripts/client-update-signing.mjs generate <仓库外私钥.json> <新的公钥.pem>
```

私钥使用当前 Windows 账号 DPAPI 保护，不可加入 Git。将新公钥复制到 `infra/client-update-public.pem`，再运行 `node apps/client/scripts/prepare-updater-trust.mjs`。它同时生成 TypeScript 与原生更新器信任源。保留原有已安装版本的信任关系/升级兼容性，不将不同发行者的签名根混用。

## 3. 准备固定 Harness

从 `upstream.lock.json` 的官方仓库获取精确 commit `687f282e8625c6b8d11ff58211a90524be2e4317`，放到独立目录（下文 `<UPSTREAM>`）。在该 checkout 按固定 pnpm 和上游锁安装，执行：

```powershell
pnpm install --frozen-lockfile
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh --config.store-dir=<独立缓存> --config.node-linker=hoisted --config.allowUnusedPatches=true deploy --prod --legacy <STAGE>
```

`<STAGE>` 必须是新的部署暂存目录。deploy 会重新解析部分第三方范围，应保留它生成的生产锁与最终哈希；固定上游 commit 不等于所有第三方输出字节天然一致。

回到企业仓库根目录执行：

```powershell
node apps/client/scripts/prepare-runtime.mjs <STAGE> <UPSTREAM> https://dsh.example.com production
```

脚本拒绝覆盖已有 `apps/client/runtime`，并校验上游 commit。使用新的候选目录，不热替换正在运行的客户端。

## 4. 准备 SolidWorks 构建输入

公开仓库保留工具、历史证据和参考算法；未再分发本机提取的专有类型库目录。需要合法安装的 SW2016，先准备 pywin32 并使用其 Python 3.12 环境运行：

```powershell
python scripts/download-solidworks-wheels.py
python scripts/build-solidworks-catalog.py --installation <SW2016类型库所在目录> --output preinstalled/solidworks/catalog
```

第一个命令仅下载锁定 wheel 并验证 SHA256，不安装到系统 Python；第二个命令需要运行它的 Python 环境已有 pywin32（可在隔离 venv 安装已下载 wheel）。目录提取不等于方法执行验证。`evidence/` 是已脱敏的历史记录，保留失败与限制，不是新机器验收结果；`recipes/` 是参考文本，部分依赖历史测试辅助模块，不能直接作为完整可执行项目。

## 5. 准备全部预装与原生更新器

```powershell
powershell -NoProfile -File scripts/Prepare-ClientPresets.ps1 -Runtime <候选runtime绝对路径> -NpmCli <npm-cli.js绝对路径>
node scripts/brand-runtime.mjs apps/client/runtime
node apps/client/scripts/prepare-node.mjs <官方Node24.16.0的node.exe>
node apps/client/scripts/configure-company.mjs https://dsh.example.com production
powershell -NoProfile -File apps/client/scripts/build-updater.ps1 -OutputDirectory apps/client/build/updater
npm run build
```

`Prepare-ClientPresets` 依次准备 Office/PDF/OCR、侧栏、媒体直解、电脑操作、Remotion 和 SW。需完整品牌图标的发行构建，可为 `build-updater.ps1` 传 `-IconPath <公司.ico>`；当前仓库品牌原图为 PNG，未提供独立 ICO 生成流程。

两份较小的安装器 DLL、固定源码归档、完整许可和可重放补丁保留在 `apps/client/preinstalled/installer`。它们按固定摘要检查；如用其他工具链重编译，应审查产物并更新对应锁，不删除校验。

## 6. 验证后打包

设置 `RUFA_RUNTIME_ROOT` 为候选 runtime 的绝对路径，执行：

```powershell
npm run test:history-safety
npm run package:win --workspace @rufa/client
```

打包前、打包后和解包检查均验证必需资产。缺少 CAD 目录、预装、更新器或当前会话安全回执时必须失败。继续完成独立账号、权限隔离、媒体播放、桌面、CAD、升级/回滚实机验收后再发布；不要把编译通过称为全部能力验收通过。
