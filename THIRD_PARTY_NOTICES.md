# 第三方组件

本仓库没有统一替代第三方的许可证。固定来源、版本和校验摘要在 `upstream.lock.json`、`preinstalled.lock.json`、各预装 `package-lock.json`、`sources.lock.json`、`player.lock.json`、`dependencies.lock.json` 和安装器锁中。

- DeepSeek Harness：按固定官方 commit 获取，构建时保留其 LICENSE。
- Office/PDF/OCR、Python、侧栏和媒体预览：见 [客户端第三方通知](apps/client/preinstalled/THIRD_PARTY_NOTICES.md)。PyMuPDF/MuPDF、LibreOffice、AVPlayer 等各自条款不能由插件 MIT 许可覆盖。
- 电脑操作、Remotion 技能与制作运行环境：见 [桌面与视频第三方通知](preinstalled/desktop-video/THIRD_PARTY_NOTICES.md)。技能授权不包含 Remotion 商业许可；Chrome、编码器及其他依赖保留原通知。
- 安装器组件：见 [安装器来源与构建](apps/client/preinstalled/installer/README.md)，随源码包含 7-Zip/Nsis7z 原归档与 License.txt、copying.txt、unRarLicense.txt。
- SolidWorks：专有软件及本机类型库提取物不在公开源码中；生成脚本需要合法安装。pywin32 按固定 PyPI 来源获取，解包时保留其原许可文件。

此清单说明来源组织方式，不替代逐项许可全文。项目自有代码的当前授权状态见 [NOTICE](NOTICE.md)。
