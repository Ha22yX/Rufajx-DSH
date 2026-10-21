# Windows x64 无体验差异瘦身记录

日期：2026-10-19。用户要求界面、功能、输出效果、操作方式均不改变。本轮采用固定平台文件精简，不删插件，不替换引擎，不改变运行时依赖图。

## 已应用范围

固定 Harness `687f282e8625c6b8d11ff58211a90524be2e4317`、Windows x64、node-pty `1.2.0-beta.15`。只移除 `node_modules/node-pty/prebuilds/win32-arm64/` 下六个锁定文件；完整路径、尺寸与 SHA-256 在 `apps/client/runtime-slim.lock.json`。固定 loader 按 `process.platform` 和 `process.arch` 选择预编译目标，这些 ARM64 文件不参与 Windows x64 执行。

保留所有 x64 二进制、PDB、JS、源码映射、类型声明和许可证，以及 Python、OCR、Office/LibreOffice、音视频、Better Sidebar、终端与现有插件的全部有效依赖。没有依据“看似未用”去删动态可加载包：例如 Better Sidebar 的嵌套依赖虽较大，裁剪会改变外部插件可解析的模块集合，因此未删。

## 实测结果

以下是运行目录的逻辑文件尺寸，不是压缩安装包尺寸、全机物理磁盘回收量或内存占用；独立 Node/Electron 不在此目录统计内。瘦身记录文件单列，不计入内容对比。

| 项目 | 应用前 | 应用后 |
| --- | ---: | ---: |
| 文件数 | 47,843 | 47,837 |
| 字节 | 1,159,810,229 | 1,148,041,845 |
| MiB | 1,106.081 | 1,094.858 |

减少 11,768,384 字节，即 11.223 MiB，约 1.01%。应用前后对全部保留文件的路径、尺寸与内容 SHA-256 排序聚合一致：

`1a34c27901b3201f985ad66edfcb4949684ee8d2873979d18085b3a53dbde19d`

策略 SHA-256：`cb5d3ac0e5c22e2210a86c9b59a135c67298e4f1cf80f45ccd1d8def63b3ac88`。

## 重放与保护

- `runtime-slim.mjs` 默认审计，显式 `--apply` 才写入。核对平台、上游版本、目标及保留原生文件的哈希；只逐个 unlink 固定文件，不递归删除。
- 初次应用完整枚举前后保留文件，支持中断记录恢复。后续幂等运行检查固定原生文件，不将历史聚合 SHA 宣称为每次重新全量校验。
- 路径必须 canonical 且内部不可存在 symlink/junction。Windows Codex 的 LOCALAPPDATA 虚拟化由可信构建入口先 realpath，精简工具本身不放宽路径检查。
- 集成到 prepare-runtime、check-runtime、Start-Dev。主程序启动不运行全量哈希扫描；不增加日常用户界面等待。
- 打包检查发现 ASAR 过滤会漏掉 main 使用的 `dist/runtime/empty-session-policy.mjs`，已精确保留此模块并通过真实 matcher/临时 ASAR 导入验证。现有 runtime 与 runtime/node_modules 两条 extraResources 是打包器所需，不是两个完整重复副本，保持不变。

## 验证与实际交付

- 独立候选 `rufa-slim-runtime-VVnuhq`：完整内容核对通过；六文件外 47,837 个文件字节不变。
- 精简与打包专项 4/4：只读审计、固定删除、幂等、中断恢复、保留文件校验、硬链接同源保护、错误输入拒绝、junction 拒绝及真实 ASAR 导入。
- 真实 Windows x64 PTY 1/1：原生终端启动、输入输出、resize、正常退出均通过。
- 真实 Electron 综合回归 1/1（`rufa-desktop-continuation-aSB72k`）：停止任务继续、冷历史、完成态、草稿切换、单次发送、Better Sidebar 设置、音视频解码/播放/拖动及 Range。只用本机 mock，无收费模型请求。
- 实际更新前确认无运行任务、草稿或对话框，并优雅关闭。六个原始文件另存本机 `RufaDSH/maintenance/runtime-slim-20261019-081936`，保留回退能力，因此不把减包量宣称为全机物理回收量。
- 首次实际应用因虚拟化目录参数被 canonical 检查拒绝，未删除文件；修正可信入口路径解析后成功应用。实际 runtime 完整哈希及 before/after 数字与候选完全一致。
- Start-Dev 已重新打开实际开发版：signedIn=true、Harness running、startup ready、输入框可见、无 alert。原有 5 条完整聊天历史与维护备份一致，只允许同步确认指针前进；已清理目标未复活、local 空白为 0。

没有重建 Windows 安装器、部署云服务、改动用户工作文件或降低生成质量。没有声称启动速度、模型速度或内存占用改善。更大范围的依赖裁剪无法在当前证据下满足完全等效要求，故未应用。
