# SolidWorks 2016 建模工具包

只在用户明确要求用 SolidWorks 建模后加载本说明。普通聊天不注入接口目录、验收报告或脚本。用户不需要写代码；由智能体生成经过原生审查的代码并交付模型。

## 先判断能力和证据

1. `company_solidworks(operation="detect")` 只检测安装和离线 Python/COM 依赖，不启动 SW。不自动安装、激活或修改许可。必须是可正常启动的 SW2016；其他版本不冒充已适配。
2. `libraries` 展示从 SW2016 安装提取的 20 个类型库索引。`search` 按关键词、`member` 按精确方法名、`type` 按接口、`enum` 按常量查找；可指定 library/type，并用 offset/limit 分页。枚举查询返回实际值，不能猜整数。
3. `recipe` 查询历史方法参考，`evidence` 查询通过或失败记录。35 份正式接受样例的 956 项断言，是这些具体样例的检查数量；不是 956 个工具，也不代表全部 SW 操作已测。112 份记录包括失败、诊断、崩溃及最终修正，不能只看 complete=true 就宣称普遍支持。
4. 核心建模库 403 个类型、13,712 条方法/属性记录；全部类型库共 1,817 个类型、24,148 条方法/属性记录和 10,872 条常量。接口/重载/属性是不同记录，不是互不重复的用户功能。附加模块仍受本机安装与许可限制。

## 执行方式与文件

使用 `company_solidworks_run(stepTitle="当前步骤", code=本步骤完整Python代码, timeoutSeconds=300)`。每一步都是独立可审查的完整工具参数，沿用原生工具审查、公司身份和当前工作文件夹修改前版本保护。执行器不是 Python 沙箱；不得隐藏代码、下载执行、改变审查策略、接管其他实例或绕过文件范围。

同一账号的同一真实会话持续持有一个默认可见的专属 SW 实例和 Python/COM 上下文。首次通过实际启动 PID 对应的 ROT 项绑定，确认启动完成、24.x 版本和空实例后才开始建模；后续调用在同一个窗口和模型上接着做，保留 `doc` 等变量。不同会话不混用实例。禁止 `GetActiveObject`、`DispatchEx`、另启 SW、全局进程结束或关用户原窗口。只使用预置 `cad`、`sw`；不隐藏专属窗口，不关闭图形更新。用户原有窗口、未保存模型及其显示状态保持不动，不能声称它们已同步更新。查询接口或检查安装不会启动建模窗口。

## 先规划，再逐步观察与建模

默认执行节奏是：理解要求 → 简短可见计划 → 一个有意义的建模步骤 → 核对真实结果 → 决定下一步。先在聊天中说明预计步骤和必要的尺寸假设；需要用户补充的关键尺寸才询问，不为每一步重复索要批准。可使用当前实际提供的原生计划工具，不能假设不存在的工具。

- 每次 `run` 只做当前有明确目标、能核对结果的一步，例如“建立基体”“增加安装孔”“调整圆角”“保存与交付”，而不是每个API调用一个工具，也不是默认用一大段脚本从零生成完整复杂项目。不要为了减少调用次数把后续尚未验证的操作全部合并。
- `stepTitle` 写员工看得懂的当前步骤。先查看已有状态，使用 `doc = cad.active()` 或已有 `doc` 继续；只有确实要新增零件/装配/工程图时才 `cad.new()`，不得每步从零重建。
- 每步重新获取需要的特征、面和选择，清除不需要的旧选择；重建/切配置后旧 COM 引用可能过期。按需核对特征错误、体积/尺寸/实体数，`cad.check` 失败即停在本步。重要外形用 `cad.preview` 生成图片并用实际图片读取工具查看，再决定下一步；不能仅生成截图就称“已检查”。
- 普通脚本/几何检查失败保留窗口和部分结果。先查当前文档、特征和恢复副本，说明失败点，修正这一小步；不得无检查地重复创建同名特征或从头重做。接口断开、超时强制停止等未知结果不能自动重放，等待新的用户指令并核对实际文件。
- 工具 `completed` 只表示这一步代码已执行完，不等于整个项目完成或几何合格。逐项核对计划、尺寸、重建、保存及交付文件后才能宣布完成。交付模型和预览，说明未覆盖的工程验证。
- 建模完成后默认保留窗口和模型供用户查看，**不要调用 ExitApp、CloseDoc、finish 或 close 作为例行收尾**。`company_solidworks(operation="status")` 只读检查当前专属窗口状态；用户要结束自动控制但保留窗口时，`company_solidworks_run(operation="finish")` 交还窗口。交还后不再自动接管旧窗口。
- 用户最新真实消息明确要求关闭本任务 SW 窗口时，才使用 `company_solidworks_run(operation="close")`。未保存或未命名模型会拒绝关闭，应先保存成果再关闭；不自动丢弃修改。不能关闭用户其他窗口。注销/客户端退出只停止自动执行、交还窗口，不关闭模型。

工作目录由宿主确定，不接受模型指定账号、程序路径或进程。`cad.path`、open/save/preview 限当前目录，原文件写入须在版本保护范围。参考目录文件先通过原生已审查文件工具复制到当前工作目录，再操作副本；装配须完整复制引用文件并核对引用路径。自动打开的外部装配引用和插件缓存不属于整盘备份，禁止隐式修改它们。

每步执行前后将未保存的独立模型另存恢复副本到当前目录 `.rufa-sw-recovery/<本次调用>/`，不关闭或重命名当前模型。失败、停止、崩溃时，只报告实际保存的文件；原生接口卡住时可能无法保留最后一步，不得称所有修改都已恢复。恢复副本不是完整装配打包，外部引用仍须单独核对。停止后等待新的用户要求，不自动重放未知操作。不使用脚本处理激活或试用提示。

## 预置对象与便捷方法

- `sw`：专属实例的原生 `ISldWorks` 对象，可经文档接口访问全部本机可用 COM 建模方法。没有把“只封装了拉伸”等同完整功能。
- `get(obj, "方法或属性", *args)`：兼容 pywin32 对零参数方法、属性和可调用 COM 对象的差异。
- `pythoncom`、`VARIANT`、`NULL`、`math`、`Path` 可直接用。原生 API 长度用**米**，角度用**弧度**；cad.extrude 深度为毫米、cad.volume 为立方毫米。
- `cad.new("part"|"assembly"|"drawing")`：自动查找本机 SW2016 模板。
- `cad.active()`：取得同一专属窗口当前活动模型；没有模型时明确报错，不隐式新建。
- `cad.open("零件.SLDPRT")`：打开工作目录现有文件；不接管原窗口。
- `cad.sketch(doc, draw=lambda sketchManager: ..., name="轮廓", plane=0)`：按模板基准面顺序选择，不依赖中文面名。plane也可用明确名称。返回 feature/entities。
- `cad.extrude(doc, depth_mm, name="拉伸", merge=True)`：已验证的 FeatureExtrusion3 参数形式。
- `cad.feature(nativeResult, "特征名")`：检查非空及 GetErrorCode2。
- `cad.features(doc)`：遍历特征；`cad.volume(doc)`：重建后实体体积。
- `cad.save(doc, "零件.SLDPRT")`：保存并检查 errors/warnings/文件存在。另存、导出用准确扩展名，导出选项按目录原生方法显式设置与核对。
- `cad.reopen(doc, savedPath)`：关闭当前文档后重开文件。所有旧 feature/component 引用失效，必须重新取得。
- `cad.preview(doc, "预览.bmp")`：保存视图；复杂几何另换视角检查，不用单张图片代替尺寸验证。
- `cad.check("检查名称", condition, **实际数据)`：记录真实断言，失败终止本批。

分步示例（50×30×10mm长方体，下面三段分别作为三次工具调用，不一次合并）：

第一步“建立矩形草图”：

```python
doc = cad.new("part")
cad.sketch(doc, lambda s: s.CreateCornerRectangle(0., 0., 0., .05, .03, 0.), name="矩形")
```

第二步“拉伸并核对体积”（沿用同一 `doc`；重新选取已存在的草图）：

```python
doc = cad.active()
doc.ClearSelection2(True)
cad.check("选中矩形草图", doc.FeatureByName("矩形").Select2(False, 0))
cad.extrude(doc, 10, name="实体")
cad.check("体积", abs(cad.volume(doc) - 15000) < .001)
cad.preview(doc, "长方体.bmp")
```

查看实际预览后，第三步“保存成果”：

```python
doc = cad.active()
cad.check("交付体积", abs(cad.volume(doc) - 15000) < .001)
saved = cad.save(doc, "长方体.SLDPRT")
# 留在当前窗口供用户查看，不退出SW、不清空文档。
```

需要重开验证时先保存，再明确使用 `cad.reopen`；它会使旧特征/面引用失效，不作为每一步的固定动作。不要把上面具体样例的尺寸或步骤套到其他用户模型。

## 按任务查方法

| 工作 | 查询入口示例 | 必须核对 |
|---|---|---|
| 草图、约束、尺寸 | ISketchManager、AddRelation、AddDimension、EquationMgr | 单位、轮廓闭合、约束、尺寸和自由度 |
| 实体特征 | FeatureExtrusion3、FeatureRevolve2、FeatureCut3、FeatureFillet、InsertFeatureShell | 特征错误、实体数、体积和实际尺寸 |
| 曲面、扫描、放样、修剪 | InsertProtrusionSwept、InsertProtrusionBlend、InsertTrimSurface、Knit | 曲线方向、选取标记、连续性、曲面面积/采样点 |
| 阵列、镜像、移动实体 | Pattern、Mirror、MoveCopy、FeatureData | 数量、对称性、变换轴、坐标、重建与重开 |
| 钣金 | SheetMetal、BaseFlange、EdgeFlange、Hem、Forming | 厚度、折弯半径、展开状态与DXF实际内容 |
| 焊件 | StructuralMember、Gusset、Weld、CutList | 型材引用、修剪、角撑厚度、焊缝和切割清单 |
| 装配、机械配合 | AddComponent、AddMate、Gear、Cam、MateEntity | 固定/浮动、引用、干涉、运动约束与保存后结果 |
| 工程图、爆炸图、BOM | DrawingDoc、CreateSectionView、Detail、Explode、InsertBomTable | 视图比例/位置、来源、数量、配置和表格单元格 |
| 导入导出、属性、配置 | OpenDoc6、SaveAs、CustomPropertyManager、Configuration | 错误/警告、依赖、配置、重开和导出内容 |
| Motion/Simulation/路由等附加模块 | libraries 后指定对应类型库 | 本机模块与许可、方法可调用性；当前不宣称已全面测试 |

以上是检索词，不保证某字符串就是可直接调用的方法。先用 search 找到返回的真实接口/方法，再用 member 取签名。

## 已知 SW2016 适配经验

- 使用原生 Windows 路径和实际 2016 模板。不得用其他版本 API 文档参数套在 2016 上；如 FeatureCut4 不存在，使用查询出的 FeatureCut3。
- FeatureFillet 版本参数数量不同。草图从真实 ProfileFeature 取得；不要猜不存在的 Sketch.GetFeature。
- Dispatch 数组、BYREF 输出参数应使用正确 VARIANT；通过 member 查询 VT/参数标记后构造。返回 None/false 不当成功。
- 重建、切配置、重开后重新获取 Component2/Feature/Face 引用。GetBodyBox 只提供近似框，精确尺寸用 GetExtremePoint 或正确几何采样。
- 自定义属性 Get5 的 resolved 字段在样例中可能为空；使用 Get2 的显式 BSTR 输出并检查实际值。
- 旋转实体样例通过 feature definition 的 RotationType=2/RotationX=0/RotationY=0/RotationZ=pi/2 修正；原 InsertMoveCopyBody2 轴参数尝试曾失败。
- 齿轮配合样例使用角尺寸驱动验证 2:1 比例，保存重开再验；原始 DragOperator 尝试失败，不能据一次配合创建推断正确运动。
- 凸轮最终样例使用闭合相切胶囊轮廓、cam mark=1/follower mark=8、Alignment=1。错误的偏心圆选择曾造成独立实例崩溃；先查 cam-capsule-antialigned 参考，不盲目重试已知坏组合。
- 放样样例质量积分与解析值存在约4.7ppm差异；明确采用10ppm容差及221个UV点0.001mm几何检查，不能声称绝对精确。
- Pack and Go 的历史自动化尝试未通过，不作为可用快捷方法。需要完整装配交付时先核对引用，可探索官方 API 或原生电脑子任务，但须实际验收才能称成功。
- 缺字体、试用或附加模块许可提示不是建模成功；如需用户处理，明确具体阻塞。

## 未封装需求允许探索

用户要求优先。先查本地完整签名/枚举和历史失败；目录没有的接口可查本机 API 帮助或官方 SW2016 文档，禁止假设新版方法可用。使用现有已审查命令能力和提供的独立实例，在副本上做最小验证；必要时通过现有电脑专用子任务处理 UI-only 操作，仍保留原生审批和 Esc。不得通过脚本规避拒绝、停止或许可证。

验证应包括：输入尺寸/单位 → 正确选择和特征非空 → 重建/错误 → 几何/实体/配置/约束 → 保存错误和警告 → 重开再次检查 → 预览/成果路径。记录实际失败和限制，不以截图好看代替验证，不把一个样例推广为所有操作完美兼容。
