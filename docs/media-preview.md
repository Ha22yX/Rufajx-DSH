# 本机视频与音频预览

## 原文件直接播放

保留 Better Sidebar 0.28.0、视频插件 0.1.4 与音频插件 0.1.0。浏览器能正常播放的视频使用原生播放器；不支持的编码或只识别到音轨、没有画面时，自动交给离线 libmedia AVPlayer 1.3.1。新内核读取同一个原文件，按需解封装、解码并绘制，不生成另一种编码的副本，也不启动 FFmpeg 转码进程。

直解播放使用与原版 Chromium 控件相同布局的内嵌底部渐变控制栏：播放/暂停、时间、悬停音量、全屏、三点菜单和细进度条，播放速度（0.25–2 倍）及下载放入菜单。可原生播放的文件仍使用浏览器原生控件。正常暂停不再显示外部文字按钮和状态提示。

打开时不自动出声；隐藏窗口或标签时暂停，保留仍挂载预览的解码器和最后画布，返回不自动播放、不重置相同尺寸的画布。关闭预览、切换源、注销或失败时释放实例；不会把暂停截图写入磁盘。全屏只放行当前已鉴权工作台主 frame，其他来源、子 frame、失效账号均拒绝；浏览器仍要求用户操作。损坏、权限不足、不存在或不支持的文件显示可重试错误。播放不消耗模型 token。

音频保留原插件的波形、声谱、声道、倍速和 A–B 循环，常用 MP3/WAV/FLAC/M4A/OGG/Opus 使用原生解码。不能根据扩展名宣称所有编码都支持：当前 libmedia 没有 ASF 容器读取，常见 ASF 封装的 WMA/WMV 不在已支持范围；明确提示失败，不静默转码。

## 路由与隔离

原 `/video`、`/audio-preview/{meta,media}` 经过原生连接准入、会话权威工作目录和账号边界检查，忽略浏览器提供的 cwd。冷会话读取不取得云会话写入租约。打开后核对文件身份，从检查过的文件描述符流式读取，支持 Range、HEAD、If-Range 和拖动播放。

`/rufa-media-player` 只分发固定允许列表中的本地 JavaScript/WASM/许可证。检查连接准入，限制到当前 runtime 的 `company-tools/media-player`，不接受用户文件路径，也不允许目录穿越或指向外部的链接。解码器模块只从同源本机路由读取，不在员工播放时访问 CDN 或安装依赖。

之前的 `/preview/prepare/status/media/release` 转码接口已删除，不再创建账号媒体转换缓存。迁移只清退校验值匹配的旧专用 FFmpeg 和转换服务文件，不删除用户原文件、其他应用的 FFmpeg 或未知内容。

## 固定版本与构建

- `preinstalled/media-preview/player.lock.json` 固定 AVPlayer 1.3.1、源码提交 `152f629d3021fd8013efa464fcb7b55f9fbe7753`、32 个 UMD 模块、38 个 SIMD WASM 模块及许可证的 SHA256。目标是当前 Electron 44.9.0 Windows x64。
- `scripts/media-player-runtime.mjs` 只在构建机准备、校验离线组件。没有 encoder 或 AVTranscoder。组件共 25,733,633 字节，另附 lock 与 NOTICE；原专用 FFmpeg 可执行文件单独为 87,638,016 字节。
- `scripts/media-preview-compat.mjs` v4 验证原始 npm 文件和已发布 v2/v3 完整哈希，原子应用公司路由与客户端适配。上游源码保持只读。
- libmedia 使用 LGPL-3.0-or-later，原始 JavaScript/WASM 独立分发，随包保存 LGPLv3/GPLv3 正文、准确源码版本和构建链接。正式安装包发布时应提供相应源码及可替换组件所需材料；本轮不重新生成安装器。

## 验证

- `tests/media-preview-compat.test.mjs`：实际补丁插件的鉴权、Range、跨账号/目录边界、Windows junction、资产允许列表与旧转码接口移除；`RUFA_MEDIA_SOURCE` 指向固定 npm 原包目录。
- `apps/client/test/media-preview.test.mjs`：原生优先、直解状态、生命周期、权限错误、重试、严格补丁迁移等。
- `tests/desktop-media-direct.test.mjs`：独立账号、真实 Electron 内核，直接解码/播放/拖动 MPEG-4、有声视频与音频，切换标签、损坏文件、原文件校验值与零模型请求。样本生成器由测试环境 `RUFA_MEDIA_TEST_FFMPEG` 指定，仅生成测试数据，不随客户端分发。

验证记录见 `docs/status/client.md` 及总开发状态，区分独立内核验证、完整侧边栏验收和实际开发版更新。
