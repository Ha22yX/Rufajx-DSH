# 企业客户端与服务端协议 v0.1

状态：首个可运行纵向闭环的共享协议。以下字段为 camelCase，时间为 ISO 8601 UTC，ID 为不可猜测字符串。API 基址统一 `/api/v1`；错误 `{error:{code,message,requestId?}}`。需要鉴权的端点使用 `Authorization: Bearer <company access token>`，这不是上游 API Key。

## Windows 客户端版本分发（2026-10-20）

### 0.3.0 文件增量协议（2026-10-21）

- 保留下文 `latest.yml` 与完整 NSIS EXE 的旧协议。0.2.x 通过一次可见进度的完整安装桥接到 0.3.0；不得把桥接称为增量安装。0.3.0 起优先文件增量：本机实读摘要，只下载及替换变更/缺失文件，不卸载或复制未变文件；最低启动器版本不满足时使用明确的完整更新回退。
- 与旧 feed 共用唯一 `current.json`。新增 `GET/HEAD incremental/latest.json`，返回 `{schema:1,version,releaseDate,minUpdaterVersion:'0.3.0',manifest,installer}`。`installer` 等于旧 `files[0]`。`manifest` 为 `{url:'releases/<version>/incremental-manifest.json',size,sha512,algorithm:'rsa-sha256',keyId,signature}`，也作为磁盘 `manifest.json` 中可选的 `incremental` 字段；旧公开 feed 不投影它。
- 清单原字节由 RSA-3072 / SHA-256 PKCS#1 v1.5 签名，固定算法不可由网络选择；`keyId` 是 SPKI DER 的 SHA256 小写十六进制，签名为 384 字节标准 base64（512 字符）。客户端及独立本机更新器均内置公钥，验签后才信任文件集。发布私钥仅在构建账户经 Windows DPAPI 保护，不进入客户端/服务器；服务端仅配置 `RUFA_CLIENT_UPDATE_PUBLIC_KEY_FILE` 指向公开 SPKI PEM，缺失/错误仅使增量接口 503，旧接口保持可用。这是更新清单签名，不是 Windows 安装包发布者签名。
- `GET/HEAD releases/:version/incremental-manifest.json` 提供已签名完整目标集合：`{schema:1,version,platform:'win32',arch:'x64',releaseDate,minUpdaterVersion:'0.3.0',files:[{path,size,sha256,sha512}]}`。最多 64 MiB / 200,000 文件。`size` 允许 0；摘要均对原文件字节。路径只允许 Windows 安全相对正斜杠路径，拒绝绝对/盘符/ADS/设备名/尾点空格/空段/遍历、大小写冲突及文件祖先冲突。不得附远程命令或任意来源 URL。
- 稳定入口 `Rufajx-DSH.exe` 及 `Rufajx-DSH.exe.config`、NSIS 卸载器、`.rufa-update/**` 不属于增量受管集合；真实 Electron 入口为 `Rufajx-DSH-App.exe`，保留同目录 resources。启动器升级使用完整安装，不能由文件清单绕过。首次没有旧已签名清单时不删除未知文件；后续只从已验签旧集合计算删除差集，业务文件/账号缓存不属于安装负载。
- `GET/HEAD releases/:version/payloads/:sha256` 只提供该已发布版本清单声明的原字节对象，物理内容存于发布根 `objects/sha256/<前2位>/<完整sha256>`。不可凭任意 hash 读取未声明对象。支持旧接口相同 Range/If-Range/ETag/HEAD/416；空文件普通读取 200 长度 0，Range 为 416。文件身份/摘要、无链接、安全路径及下载限流覆盖两种更新接口。
- 客户端更新在登录前安全门禁进行。独立更新器先显示进度，再退出旧客户端、按事务保存变更前文件并替换；失败或中断可恢复，不允许半更新启动。稳定桌面入口在更新期间打开进度/恢复界面。未变文件保留，完成全量目标校验及事务提交后才启动新版。不得因故障关闭审查、清空账号或用户文件。
- 发布先完整核对 EXE、签名清单和全部 CAS 对象，最后原子切换共享 current；旧版本清单及其对象保留，已有下载不中断。新增格式不能破坏旧版本分发、会话/权限接口或泄漏业务/凭据。

- 正式 Windows x64 客户端在登录恢复、启动工作台之前检查固定公司 HTTPS 源：`/api/v1/client-updates/windows/x64/latest.yml`。这是公开安装程序分发接口，不传公司登录令牌、真实模型密钥或任何用户资料。仅接受高于本机的稳定三段版本；相同、更旧及预发布版本不安装。
- `GET/HEAD latest.yml` 返回 electron-updater GenericProvider 兼容清单，JSON 作为合法 YAML 序列化：`{version,releaseDate,files:[{url,sha512,size}],path,sha512}`。`url/path` 精确为 `releases/<version>/Rufa-DSH-<version>-x64-Setup.exe`，只有一个完整 NSIS 安装程序。该清单不长期缓存；没有已发布版本返回404，已指向的版本损坏返回503，不使其他业务接口退出。
- `GET/HEAD releases/:version/:filename` 只分发该版本清单声明的安装程序及可选的同名 `.exe.blockmap`，支持单字节 Range/206/416 与不可变缓存。拒绝路径穿越、其他磁盘文件及外源跳转，公开响应不泄露服务器绝对路径。
- 服务端 `RUFA_CLIENT_RELEASES_DIR` 默认 SQLite 同级 `client-releases`（PostgreSQL 为 `data/client-releases`）。`current.json` 只有 `{version}`；不可变的 `releases/<version>/manifest.json` 具有上述字段，并可额外有 `blockmap:{size,sha512}`。该扩展只供磁盘校验，不进入公开latest。发布先上传全部产物、核对大小及 SHA512，再原子切换 current；不得覆盖已存在版本或发布降级版本。
- 启动 UI 展示实际检查/下载字节/校验/准备安装阶段。包完整且校验通过后仅在登录前安全门禁内自动安装重启；网络故障可重试或继续旧版。用户一旦继续进入客户端，不得在后台强行重启，不在系统关机时自动执行更新。开发运行不安装生产更新。
- 所有预设和依赖仍由完整安装包提供，更新不依赖员工安装 npm、Python 或下载技能。SHA512 完整性及固定 HTTPS 来源不等于发布者代码签名；有 Authenticode 发布者配置时继续原生验证，不关闭签名检查以绕过失败。

## 登录
- `POST /auth/login`：`{username,password,deviceLabel?}` -> `{accessToken,refreshToken,expiresAt,deviceId,user:{id,username,displayName,jobTitle,role}}`。jobTitle默认空串；deviceId 为服务端签发的该登录设备会话标识，客户端不得自定；refresh 时保持不变。
- `POST /auth/refresh`：`{refreshToken}` -> 同登录结构；续期轮换且可撤销。
- `POST /auth/logout`：需 access token，撤销当前登录会话；204。
- `GET /auth/me`：需 access token -> `{user:{id,username,displayName,jobTitle,role}}`。
- `PATCH /auth/profile`：需access token，严格输入`{displayName,jobTitle}`。姓名原始长度≤128且trim后非空，职位原始长度≤100且允许空，两个字段trim后持久化，200 `{user}`。只能修改本人资料，不接受角色/账号ID；不会撤销登录。客户端即时刷新公开资料，模型下一次上下文组装经只读桥接`GET /company/account`读取服务端`/auth/me`。
- `POST /auth/change-password`：需当前 access token，输入 `{currentPassword,newPassword}`，修改本人密码；服务器校验原密码和新密码规则，成功204并撤销本人全部旧登录。原密码错误返回400 `INVALID_CURRENT_PASSWORD`，不误报为认证失效。客户端成功后清除本机旧登录与已记住的旧密码，回登录页使用新密码。不得接受客户端指定目标账号。
- role 仅 `employee | admin`。每次授权读取当前账户状态。禁用/删除用户拒绝现有凭据。密码哈希保存，无默认生产密码。

## 个人工作偏好

- 所有接口只操作当前登录账号；管理员在这些接口中也不能指定他人。偏好用于输出默认值，不能授予权限、改变审查、模型、工具能力或文件保护。账号资料、凭据和临时业务事实不属于偏好。
- `GET /preferences` → `{revision,settings:{enabled,version},entries:Entry[]}`。初始 revision=0、enabled=true、设置版本0；快照包含删除标记，省略条目不表示删除。
- Entry 为 `{id,scope:'account'|'project',projectRef?,projectName?,category,topic,text,enabled,source?,version,createdAt,updatedAt,deletedAt}`。ID与projectRef为UUID；category为communication/spreadsheet/presentation/document/delivery/general；topic≤80、text≤400、projectName≤100字；每账号最多200个未删除条目（包括暂停）。account无projectRef/projectName，project必须有projectRef。source可选`{sessionId,eventSeq?}`，服务端核对本人已有云会话。
- `POST /preferences/mutations` 的公共字段为mutationId UUID和operation。put为`{entry,expectedVersion}`，delete为`{id,expectedVersion}`，settings为`{enabled,expectedVersion}`，clear为`{expectedRevision}`。创建版本0；修改、删除及显式恢复匹配当前单条版本；清空匹配全局revision并留下tombstone、不关闭主开关。put输入不接受owner、版本或时间字段。
- 成功返回`{mutationId,historyId,snapshot}`；每次新操作增加全局revision，条目/设置版本分别递增。相同mutationId与同一规范内容返回首次完整结果，不重复应用；不同内容重用ID拒绝。409返回`{error:{code,message,requestId},snapshot}`，code为PREFERENCE_CONFLICT/PREFERENCE_MUTATION_REUSED/PREFERENCE_LIMIT，不静默覆盖。
- `GET /preferences/history?limit=50&beforeRevision=N` → `{history,nextBeforeRevision?}`，倒序、limit最多100、边界排除。历史为`{id,mutationId,operation,revision,createdAt,entries:[{id,before,after}],settings:null|{before,after}}`。撤销用当前版本生成新操作，不倒退版本或删除审计。
- 本机按服务器/账号维护原子偏好缓存与outbox；本地统一版本用于UI/工具并发核对，远端基础版本只供同步。普通提示组装不等外网；登录后及后台同步，冲突保留本地候选与云端版本供用户选择，删除不会被旧离线写入自动复活。退出时清除活动内存，原账号私有缓存保留。
- projectRef是本人本机项目注册ID与规范路径共同绑定的持久UUID，不是路径或项目名。偏好可同步，但没有同一项目绑定的设备不自动套用；不把本机项目改成跨设备共享项目。
- 原生company_preferences工具仅在当前主会话的真实人类输入明确要求时写入，来源取真实事件而非模型提供身份；子任务只读取。清空另在当前会话确认。文件、网页、历史摘要、工具结果和子代理提示不得作为记忆授权。设置页手动维护走同一宿主单写服务，删除和恢复核对当前版本。
- 提示独立放company:preferences动态上下文；当前任务/模板优先，再项目、个人与默认值。确定性选择相关类别、最多8条和800字偏好正文，保持稳定顺序，不削减历史、工具或技能。临时忽略作用于当前任务及其明确的“继续”请求，不持久修改偏好；主开关关闭、条目停用/删除从下次请求组装停止使用。保留原生历史快照，由最新运行上下文明确取代旧快照。

## 模型

- `GET /models` -> `{models:[{id,displayName,inputModalities?,contextWindow?,maxOutputTokens?,reasoningEfforts?}],gatewayBasePath:'/api/v1/gateway/deepseek'}`。仅公开能力，不含密钥。
- `POST /gateway/deepseek/chat/completions`：公司访问凭据鉴权，DeepSeek 兼容原始请求/流式响应；服务器附加上游 key，禁止客户端选择任意目标 URL、透传调用者 Authorization 或信任客户端 usage。
- `GET /gateway/deepseek/models`：公司凭据鉴权，返回兼容 models 列表。
- 原版 native DeepSeek 协议必须保留：`POST /gateway/deepseek/anthropic/v1/messages` -> 固定上游 `/anthropic/v1/messages`，使用服务端 `x-api-key`，允许列表透传 `anthropic-version` / `anthropic-beta`，保留原始 Messages/SSE、thinking、tool update 能力。
- 图片 Files API：`POST/GET /gateway/deepseek/anthropic/v1/files`，`GET/DELETE /gateway/deepseek/anthropic/v1/files/:fileId`。上传 multipart 原样转发且限长；服务端记录上传者/上游fileId/metadata，列表只列当前用户，详情/删除/模型请求中的file_id都校验当前用户所有权。不可把共享上游key下的全局文件列表直接返回员工。
- 原版 `web-deepseek-api`：`POST /gateway/deepseek/search` 与 `/fetch` 固定映射上游 `/v1/tools/search` 与 `/v1/tools/fetch`。旧辅助搜索 `web-search-deepseek` 使用上述 Messages 路径。两类都经过公司鉴权。
- 所有后台模型请求必须使用该通路。其他 DeepSeek 搜索/图片等路径先由客户端负责人确认实际运行时需要，再双方扩展允许列表；不实现任意URL代理。
- 模型上游、允许模型、真实 key 初期由服务端环境或秘密配置提供。错误脱敏；单请求限额/全局并发等可配置。

## 会话
- `GET /sessions?limit=&cursor=` -> `{sessions:[SessionSummary],nextCursor?}`。普通账号只返回本人；管理此接口仍返回本人。
- `POST /sessions`：`{id?,title?,workspaceRef?,upstreamHeader?,inheritedEventCount?}` -> `{session:SessionSummary}`；owner 由服务端决定。inheritedEventCount 为非负整数，保留原版 fork 元数据。
- `GET /sessions/:id` -> `{session:SessionSummary}`。
- `GET /sessions/:id/events?afterSeq=&limit=` -> `{events:[{seq,event}],nextSeq}`。`afterSeq` 为排除的已读序号，初始 -1。
- `POST /sessions/:id/lease`：`{deviceId}` -> `{leaseId,expiresAt,nextSeq}`。服务端验证设备与当前登录会话关联，单写入租约。
- `DELETE /sessions/:id/lease`：`{leaseId}` -> 204。
- `POST /sessions/:id/events`：`{leaseId,expectedNextSeq,events:[{seq,event}]}` -> `{nextSeq}`。事务追加、批次幂等、序号冲突409；只有所属员工（包括管理员自己的会话）可以写，管理阅读权限不产生代写权。
- SessionSummary：`{id,ownerId,title,createdAt,updatedAt,nextSeq,workspaceRef?,upstreamHeader?,inheritedEventCount?}`。event 保存原版完整事件 JSON，保留 seq 与 upstreamHeader；不转成只有 role/content 的聊天模型。
- 本机任务与工作目录不会因会话同步而变成云端任务。远程持久化 adapter 必须明确 flush/close 语义与未同步错误。

### 客户端历史与同步

- 每个公司服务器/账号派生独立 `DSH_HOME`；`company-history.sqlite` 持久缓存完整原版header和按seq排序的事件JSON，包括消息、工具参数/结果与展示metadata。成功上传后仍保留，未提交journal与同步checkpoint分开管理。
- SQLite、恢复journal与每批上传必须使用同一已持久化事件快照；异步写盘/上传期间新到事件进入后续批次，不得先上传再补本地记录。只读handle读取不得回写其旧checkpoint。历史缺口恢复逐条核对云端前缀和journal，保持序号及完整事件，不清空缓存或放宽冲突检查。
- 2026-10-21 加固：实时事件接收成功返回前，完整不可变事件必须已提交本机SQLite事务（WAL + synchronous=FULL）；journal与网络随后异步推进。本机写入失败必须报告并阻止云端写入及模型/工具准入，不能只把事件留在内存后宣称已保存。原生会话可能捕获观察者错误并继续产生收尾事件，因此仍须按序保留这些事件、重试完整尾部，不丢弃后续事件形成新缺口。
- 每会话的打开、恢复、拉取、上传和关闭使用同一串行通道；只读缓存读取不修改云端状态或checkpoint，也不排队阻塞正在通知它的同步通道。旧local journal仅供逐条核对/补齐，不能把已经remote的缓存降回local或覆盖较新尾部。传输中断和未知ACK按服务器实际完整事件校对，不凭本机计数猜成功。
- 服务端事件分页的事件与nextSeq来自同一读取快照。会话写事务在取得数据库锁后重新核验当前账号、登录凭据、会话所属关系及租约有效期；幂等返回也经过相同核验。响应丢失后的相同事件重试只确认既有记录，真正不同的事件内容仍拒绝；不得因修订摘要算法使旧数据库的精确重试失效。
- 新会话先本地创建，首次实际发送或任务执行准入时创建云端记录；仅打开空白页、键入草稿、初始化设置、flush/close不创建云端会话。fork继承内容保存在本地，首次新增提交后上传。
- 客户端离开纯空白会话时丢弃本地记录和其空草稿镜像：必须无文字/引用/附件/任务，完整header与事件符合纯初始化白名单，且未提交、未持有云端写入授权。UI与已鉴权账号持久草稿、运行时写入状态再次核对；任何未知内容、继承记录或云会话均保留。该动作仅走客户端内部协议，不扩展云端会话删除API，项目及用户工作文件不随空白记录删除。
- 缓存命中时目录、只读打开与历史正文直接本地返回；后台按目录与事件序号分页拉取增量，更新原生历史流和列表投影。首次使用本机的旧历史需要完成一次下载，后续保留。省略的目录行或网络失败不视为删除。
- 冷历史展示不自动恢复Agent、不获取云端写入租约、不补写中断结束记录；只有实际恢复/续聊才先同步并持租约，再由原生恢复逻辑处理未完成尾部。发送、模型步骤与最终工具执行均需确认公司写入权限，权限或租约失效后拒绝继续执行。
- 本地未提交事件原样重试，服务器已提交前缀逐条核对、幂等对齐；冲突保留本地记录并报错，不覆盖另一设备事件。服务器明确404仅对严格识别的纯初始化空白降级为本地，不重建有内容的丢失云会话。
- 缓存包括事件中的附件引用；本机工作区文件不因此自动上传或变成跨设备文件同步。
- 手动停止、异常中断或冷历史最后未闭合的任务可以由用户点击输入框的继续按钮续接；已有文字/附件仍按普通发送处理。继续通过原生输入提交一条可见的继续请求，复用现有会话、身份验证、同步与写入租约；不新增绕过鉴权的恢复端点，也不直接重放旧工具调用。完成/新空白不显示继续。原生恢复将结果不确定的工具标为未知，由下一轮核对，保留已停放队列的FIFO顺序。

### 项目与会话工作目录

- 客户端显式项目复用原生工作区注册；项目名称、所选本机文件夹和成员关系属于该公司服务器/账号的本地配置。普通新会话没有项目成员关系，客户端在账号目录内为其分配独立工作文件夹；显式项目会话使用项目文件夹。
- 正式Windows客户端可在首次工作台启动前，从本机固定的MSIX托管Rufa目录迁移当前已鉴权服务器/账号的项目注册、参考目录及项目偏好绑定；不扫描其他Agent目录或复制凭据、普通设置、草稿、历史及业务文件。使用精确cwd和原生header验证自动重建项，只替换自动名称，保留新会话和明确修改；旧已删除项目不得复活。迁移先备份原字节并记录prepared事务，断点按摘要重放、冲突拒绝，完成标记后不持续覆盖。
- `workspaceRef` 继续表示原生 `upstreamHeader.cwd`，不是项目ID。完整事件与header仍按既有协议同步，不因UI分类改写已存header、移动文件或重新创建云端会话。本期不新增云端项目目录API，也不将本机路径声明为跨设备可用文件夹。
- 旧注册工作区保留为已有项目，原历史和文件原地保留。首次启动或重建本地注册表时，不能把每个独立会话工作目录自动展示成项目。项目创建/取消、空白会话与未发送草稿均不得触发云会话创建。
- 创建弹窗默认自动分配工作目录；手动选择多个文件夹时，第一个为`cwd`，其余连同可选参考目录保存为`referencePaths`。使用原生系统目录选择器，不提供路径编辑框。公司私有本机`workspace/create`扩展可选`referencePaths:string[]`（最多31个），不新增云接口或改写既有header。
- 目录配置按服务器/账号隔离保存，主目录要求可写，参考目录要求存在且通过相同私有目录边界验证；比较规范化的真实路径并去重，不自动导入其他账号或设备的目录。项目Agent必须以原生`session.header.cwd`、注册表实际成员和精确绑定的workspaceId共同匹配本账号配置，在上下文获取参考目录绝对路径；未提交绑定的null记录不注入。仍走原生文件工具及自动授权审查，不扩张系统沙盒。参考目录表示预期用途，不声称是操作系统强制只读。云端会话的cwd本身不能凭空创建本机参考目录映射。

### 本机文件版本与恢复

- 成果卡片入口仅为24px低强调历史图标，悬停显示“历史版本”，具有无障碍名称和键盘焦点。卡片上不展示版本数量或大文字按钮；点击后保留本次改动、历史树及恢复流程。
- 历史视图为真实父子分支树。普通记录按保存顺序延续；完成恢复必须依据恢复日志的source_id/current_id/result_id建立来源分支及恢复前比较基准，不凭内容hash猜来源。未知/失败恢复不接成功恢复边。连续普通同内容可合并，但保留所有原始ID到显示节点的映射，备份和恢复节点独立保留；恢复关系跨重启一致。
- 树的“当前使用”仅在授权范围内实读文件并匹配最新可信记录时显示；不存在、外部变化或未知结果明确提示。卡片summaryOnly查询不读取当前文件，打开面板再核对。宽屏并列显示分支树和差异，窄屏上下排列且树可滚动，节点支持键盘选择。
- 文件版本属于每服务器/账号的本机私有数据，CAS原字节内容和SQLite索引放在本机账号目录，不写入项目文件夹或Git仓库；本期不增加云文件上传/版本同步API，不把聊天同步称为文件跨设备备份。
- 智能体审批后的明确文件写工具及受保护工作目录内的命令执行，先捕获原版本再执行、结束后记录新版本。失败或取消也检查结果，不根据工具成功文案猜测文件内容。未变化内容去重，完整备份不依赖归一化文本、Office提取结果或模型摘要。
- 工作目录来自当前已验证账号的本机会话/项目绑定；目录外明确文件目标只在原生审批后记录精确文件授权，不扩大到父目录。参考目录、外部编辑器与脱离工具的后台进程不自动视为全面受保护。依赖/缓存目录、扫描和文件大小上限必须明确；保护失败不可声称已经备份。
- 界面以成果的sessionId/事件seq/file index定位原始交付记录，不接受浏览器任意文件路径、blob路径或hash作为访问依据。列表、对比、恢复均经过当前账号/frame/origin/epoch验证及宿主权威范围复查。
- 恢复单个有内容版本前，取得当前文件fingerprint并保存当前版本；一次性票据绑定账号、文件、版本和fingerprint，确认后重新验证身份与并发状态。当前文件变化、链接重定向、私有路径/跨账号路径、权限或写入错误均拒绝覆盖。缺失状态版本不用于隐式删除新文件，原始完整聊天事件不重写。
- 与智能体受管写操作共用本机mutation锁；恢复时不得有冲突的运行任务/后台终端。锁不声称能锁住其他应用或其他设备，普通原子替换也不声称提供跨进程文件系统CAS。Windows恢复保留目标权限。
- 差异预览确定性本地执行，不消耗模型token。Word段落/表格文字、Excel工作表单元格/公式、PPT页面文字提供普通员工可读的前后对比；图片、版式等未展示部分明确说明。任何预览失败或截断都不影响已保存原字节版本的恢复。

### 公司徽章来源属性（本机）

- `company_badge` 为原生徽章技能生命周期内的工具，徽章外观保持不变。当前贡献者用户名通过既有 `GET /company/account` / `/auth/me` 取得，不接受模型提供身份，不新增云端接口、不写入凭据、姓名、职位或角色。
- `read` 读取隐藏的有序用户名列表；`stamp` 保留目标及显式来源文件的已有用户名、去重后追加当前账号。文件中已有署名视为未经认证的来源数据，不赋予任何权限，也不声称为不可篡改的数字签名。
- PNG 使用 iTXt `RufaBadge`，SVG 使用不可见 metadata；Office 使用 `docProps/custom.xml` 中的 `RufaBadge` 并同步可识别嵌入徽章；PDF 使用 catalog 的 `RufaBadge`；UTF-8 HTML/Markdown 使用不可见注释。值为 schema/badge/authors JSON。保留正文、原文档作者、图片像素与版式；截图、格式转换、第三方编辑和在线平台可能剥离属性，不能承诺自动跨平台保留。
- 写入使用原生工具审查及本机文件版本保护，和恢复共用修改锁。解析准备与发布分开：隔离 Python 进程输出 ready 后，宿主再次核验身份/取消/授权路径，才批准发布；helper 再核对目标、来源字节与目录身份并原子替换。Windows 保留目标权限。损坏、未知属性编码、签名/加密文件或并发变化拒绝覆盖。

## 管理接口（仅 admin）
- 2026-10-21 管理中心增强（待发布）：新增以下只读查询，既有客户端接口保持兼容；查看他人历史不恢复 Agent、不取得写入租约、不执行工具，也不把员工本机路径作为管理员本机可读文件。
- `GET /admin/sessions?ownerId=&q=&from=&to=&limit=&cursor=` -> `{sessions:[SessionSummary],nextCursor?,total:number}`。省略 ownerId 查询全部账号；q 最多200字符，检索会话标题及已保存的完整记录内容（包含工具过程），不是模型语义搜索。from/to 是 ISO 时间，按会话 updatedAt 筛选，from 包含、to 不包含；默认 limit=50，按 updatedAt 降序和稳定ID游标分页。客户端必须保留分页与总数，不把首页结果冒充全部。查询词及会话内容不得写入访问审计。
- `GET /admin/overview?from=&to=` -> `{accounts:{total,active,disabled,recycled,archived},sessions:{total,updatedInRange},usage:{requests,completed,failed,cancelled,inputTokens,outputTokens,totalTokens,missingUsageRequests},users:[{userId,sessions,requests,inputTokens,outputTokens,totalTokens,missingUsageRequests}]}`。账号与会话总数不受日期限制，usage 及 updatedInRange 使用同样的包含/不包含时间边界；每个用户的 sessions 是其全部已保存会话数。Token 只累加服务端实际记录的值，缺失用量单独计数，不推算费用、成功率之外的质量或员工绩效。
- 阅读页完整保留原生事件，只做显示投影。对话正文按员工/助手区分，思考、工具参数与结果可折叠展开；未知事件也有完整原文入口。长消息不做不可恢复截断，记录加载范围、继续加载/取消和错误必须明确。搜索本会话已加载内容与服务端全量记录搜索必须清楚区分，附件引用不冒充附件文件已上传。旧服务端不支持新增接口时明确显示兼容提示，不静默显示虚假完整结果。
- `GET /admin/users` -> `{users:[ManagedUser]}`。
- `POST /admin/users`：`{username,displayName,jobTitle?,password,role}` -> `{user:ManagedUser}`。jobTitle省略默认为空，原始字符串长度≤100，trim后保存；错误类型/null/超长返回400。管理员发放密码10–128位，智能体生成10位随机字母数字；默认employee，只有用户明确指定管理员才用admin。本人改密的新密码仍12–128位。
- `PATCH /admin/users/:id`：`{displayName?,jobTitle?,role?,status?}` -> `{user:ManagedUser}`。jobTitle校验同创建，省略保留原值、显式空字符串清空，可单独修改职位。status 为 `active | disabled`；拒绝移除最后一个启用管理员。
- `POST /admin/users/:id/reset-password`：`{password}` -> 204，撤销目标账户现有登录。
- `DELETE /admin/users/:id` -> 204，进入7天回收站并撤销凭据，保留会话，保护本人及最后一个启用管理员；重复删除不延长到期时间。
- `POST /admin/users/:id/restore`：无body，200 `{user:ManagedUser}`；到期前恢复active并清空删除期限，旧登录不恢复。到期或已清理返回409 `RESTORE_EXPIRED`，未删除返回409 `USER_NOT_DELETED`。
- `GET /admin/users/:id/sessions` -> `{sessions:[SessionSummary]}`。
- `GET /admin/sessions/:id/events?afterSeq=&limit=` -> 与员工读事件接口同形；写访问审计。
- ManagedUser：`{id,username,displayName,jobTitle,role,status,createdAt,deletedAt,purgeAfter,purgedAt}`，后三字段ISO时间或null；status 包含 `deleted`。deleted且purgedAt为空为回收站，非空为只保留聊天归属的归档账号。到期后启动/每60秒及管理列表触发清理，恢复事务检查精确7天边界；清除密码和可恢复资料，保留不可复用ID/username及聊天存档。绝不返回密码哈希。
- `GET /admin/settings/deepseek` -> `{configured:boolean,updatedAt:string|null}`，只显示官方API Key是否已配置；不返回密钥或其片段。
- `PUT /admin/settings/deepseek`：`{apiKey:string}` -> 同状态。仅当前有效admin可保存，输入经HTTPS提交后立即从客户端表单清除，不写客户端持久存储。服务端通过私有文件原子保存，重启可恢复，后续网关请求立即使用新Key；进行中的请求保持开始时的Key。审计仅记录修改动作，不记录Key。官方上游地址仍由服务端固定，不允许此接口选择任意URL。
- 用量、密钥管理、附件等后续增量端点须先协调；不得因此减少原版功能验收范围。

## 首轮验证
两个不同员工的数据隔离；管理账号创建/查看/停用/删除；最后管理保护；流式 mock 上游中转且公司 token 不外泄；上游 key 不进入客户端响应/日志；会话原版事件追加/冲突/恢复。默认使用服务端内嵌 SQLite，文件保存在服务器本地磁盘，WAL 与短事务保证一致性。单元测试允许注入内存存储，但集成验收必须使用真实 SQLite 文件，覆盖重启恢复与备份。PostgreSQL 仅为将来可选存储，不影响客户端接口。

管理员智能体输出约定：插件仅为管理账号加载，身份仍由服务端逐次验证；默认创建employee，不额外询问账号类型。9项管理工具包括回收站查询与恢复。写入通过当前调用绑定的一次性进程IPC请求原生会话内人工确认，不能通过模型传入approved字段授权；取消/失去当前会话/身份变化均拒绝。初始及重置密码为10位随机字母数字并按用户要求返回管理员聊天，创建/重置成功结果不包含内部ID；列表ID仅供后续工具调用。重置密码确认明确不可逆。
