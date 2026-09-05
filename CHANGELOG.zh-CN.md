# 更新日志

[CHANGELOG.md](CHANGELOG.md) 的中文版。GitHub Release 说明与应用内更新提示都从这份文件注入
（`.github/scripts/extract-changelog.mjs`），所以**发版前必须补上对应版本的条目**——缺了会在
`validate-version` 里直接失败，构建根本不会启动。

两份是人工同步的，条目一一对应；改英文版时顺手改这里，逐条 diff 能看出漏了哪条。
0.12.6 之前的版本只有英文版。

## 0.12.11 - 2026-09-06

这一版主要是前端：首屏体积砍掉一半以上，UI/UX 做了一轮系统性升级，Agent Chat 从"平铺的消息列表"变成有回合、有层级、能看见子 agent 的对话页，首页多了一个直接把目标丢给编排管家的入口。

### 新增

- **首页「对 agent 说」直达编排管家** — 快捷按钮下方多了一张输入卡：选目标项目（也可浏览目录）、选引擎、写一句目标，回车即在工作区开一个 Agent Chat 标签、以编排管家身份发出首条消息并切到工作区。首页只是发起器，对话在工作区里进行。ACP 没有系统提示词字段，管家指令随首条 prompt 交给引擎；ccpanes MCP 工具面本来就注入每个 Agent Chat 会话。原来的「对 agent 说」按钮（终端 + CLI 形态）从首页移除，引导流程里的仍保留。
- **Agent Chat 回合化重排** — 消息流按"用户 → agent 产出"归成回合：用户回合右对齐气泡 + 时间；agent 回合是头像列 + 引擎名 · 时间 + 内容块，正文用淡底卡片承载，悬停 / 右键可复制。思考块默认折叠成一行，流式中显示「正在思考…」并自动展开，收口后变成「思考了 N 秒」；回合内连续的工具调用折叠成「调用了 N 个工具」并带进行中 / 失败计数，有调用在跑时自动展开。流式指示器移进当前回合，刚发出消息时先立一个空回合承载状态。首屏多了一张欢迎卡说明现在在和哪个引擎（或编排管家）说话、工作目录在哪。分页从"最近 150 条条目"改为"最近 60 个回合"。
- **子 agent 嵌套显示** — Claude 引擎派出的子 agent（Task / Agent 工具）现在是一个独立的可折叠块：头部是任务描述 + 状态，展开后是它自己的思考、工具调用和正文，底部是最终汇报；运行中自动展开、完结后自动折叠；子 agent 再派子 agent 时递归嵌套。此前子 agent 的工具调用和主 agent 的平铺在一起分不清归属，而它的正文和思维链根本到不了前端——`claude-agent-acp` 只在客户端声明 `subagent-transcript` 能力时才转发，我们此前没声明。现在 `initialize` 声明了该能力，前端按 `_meta.claudeCode.parentToolUseId` 归属；其他引擎没有这个标注，行为不变。
- **命令注册中心** — 右键菜单、命令面板、快捷键、Ctrl+/ 速查表四处共享同一份动作注册，菜单项自动显示当前键位；截图有了命令（此前纯热键），深埋功能进命令面板，状态栏次级项可自定义收起。
- **布局成为一等公民** — 拖拽标签到窗格右 / 下边缘直接分屏（带落点预览），窗格头部右键与悬停分屏按钮，关闭窗格 / 等分 / 布局内缩放，命令面板里预设可搜索并分组。Ctrl+\ / Ctrl+- 在终端聚焦时默认生效（`terminal.splitShortcutPassthrough` 可关）。
- **右键菜单整合** — 布局行密度切换、编辑器标签复制路径、文件树空白区菜单、历史版本 / 浏览器工具栏 / git 提交行 / 聊天消息 / Monaco 编辑器内的产品动作全部补齐。
- **设置收敛** — 新的「外观」页把颜色 / 形态 / 壁纸收到一处，专家项折叠进高级，搜索锚点补全，MCP / 技能 / Provider 带作用域徽标并可跨层跳转。
- **主题编辑器** — accent 10 色预设、圆角基准滑杆、面板明度微调，一键恢复默认，导出 JSON 到剪贴板；主题卡预览同时反映当前形态。
- **响应式与密度** — 五档断点（xs / sm / md / lg / xl）成为唯一事实源：窄档侧栏转浮出层、右侧 Dock 转 Sheet、状态栏溢出收进「更多」、标题栏截断，跨档偏好互不污染；全局密度档 comfortable / compact。分屏在 md 以下有 320px 列宽下限 + 容器横向滚动。
- **视觉与手感** — 冷启动品牌瞬间（五区错峰浮入，reduced-motion 静态呈现）、语义字号阶梯、暗色主区微提亮并保住 4.5 对比度、空态插画体系（6 语义插画 19 处接入）、视图切换视差动效、9 个异步入口的 300ms 延迟骨架屏、Toaster 改底部居中、新增 separator / slider / progress / alert-dialog / radio-group / textarea / scroll-area 七个基础组件。
- **可访问性** — 文件树键盘化（方向键 / F2 / Menu）、settings 与 providers 90+ 处视觉 Label 全部编程关联、30+ 处焦点与 aria 修复、ContextMenu 支持 Menu 键 / Shift+F10、对比度脚本覆盖暗色并全强约束。

### 变更

- **首屏 JS 体积 -57%**（gzip 1914 → 831kB）：Monaco 与 xterm 改为懒加载并守住 modulepreload 禁令，新增 `check:bundle` 预算脚本（首屏 ≤1100kB、入口 ≤880kB）；文件树 / 本地历史版本 / 最近启动列表接入虚拟滚动，501 项只渲染约 27 行。
- **TerminalView 与 usePanesStore 拆分**（2226 → 711 行、2378 → 117 行），外观与行为不变，公开 API 逐项兼容。
- **移除 GLM CLI 适配** — 官方没有独立的 `glm` CLI（经 crush 间接拉起）。`CliTool` / `ProviderType` 改手写 Deserialize，老数据里的 glm 配置和会话按未知 id 回退默认值，不再整条加载失败。
- **两处回退** — 设置页导航回退为页面级侧栏 + 顶部 SegmentedTabs（不再把 22 个子面板平铺进侧栏，其后新增的设置页保留）；UI 中文字体回退系统雅黑 / 苹方，不再打包 MiSans（约 4.6MB 资源不再进产物）。

### 修复

- **生产包启动即崩 / 打开编辑器即崩** — 两个同族问题，都只在打包后出现（dev server 没有 manualChunks 从不复现）：Radix 独立分包与入口形成循环依赖，模块求值期调用 `React.forwardRef` 时 React 绑定未初始化；Monaco loader 的依赖 `state-local` 落进懒加载边界 chunk 与 monaco chunk 成环。分别并回入口 / 并进 monaco chunk 消环。另外 Monaco 语言服务 worker 从未配置过，打包后每次开编辑器都抛 `getWorker` 错误且被崩溃上报器记为 window-error，现已补配。
- **共享布局保存 / 应用 / 轮询从未工作过** — 布局空间隔离产出含冒号的 `layout-scope:` 前缀 profileId，后端校验只接受 `[A-Za-z0-9._-]`，100% 失败。生成处改单射转义分段拼接。
- **快捷命令加载被单条坏项拖垮** — 一条 SSH 伪路径让全部好条目都不显示。改 `Promise.allSettled`，失败按签名去重一次性 warn。
- **用量统计预览与「更多工具」Popover 互相争夺焦点形成 worker 级死循环** — 预览改为显式键开（Enter / 空格 / ↓）+ Escape 关闭。
- **Radix 下拉在 UIA Invoke 下打不开** — Trigger 只在 `onPointerDown` 打开而 UIA 只派发 click，事件路径断层而非 aria 缺失（docs/accessibility-notes.md）；通知铃铛 aria-label / expanded、4 处 aria-expanded / pressed 缺口一并补齐。
- keep-alive 隐藏视图层加 `inert`，消除 Blocked aria-hidden 告警；自动化设置面板不再顶贴内容区顶部；壁纸视频在被遮挡 / 视图不可见时暂停。
- **CI**：本地 npm 11 写的 lock 缺少 npm10 解析 peer 所需的 react@18 变体条目，四个 job 的 `npm ci` 全部失败——lock 现以 npm10 重生成。

## 0.12.10 - 2026-09-03

### 变更

- **`.ccpanes/` 改为默认可提交**（docs/98）。仓库里的这个目录只保留描述该仓库、值得交给团队的东西——`config.toml`、`workflow.md`、`specs/`、项目快捷命令；CC-Panes 自动写一个 `.ccpanes/.gitignore` 挡住新增的 `.ccpanes/.cache/`，所有机器本地产物都搬进去：本地历史（`history.db` + blobs，首次打开时原地改名）、媒体产物、会话日志、外置的长 prompt、hooks 同步状态。老的 `session-state.json` 不再写。应用也不再把自己的数据目录当项目：默认工作空间不会再在 `~/.cc-panes/.ccpanes/` 里长出历史库和 plan 归档，旧版本留下的那份启动时一次性清掉。仓库里仍整目录忽略 `.ccpanes/` 的照常工作；去掉那一行就能开始和团队共享 specs 与 workflow。
- **快捷命令与 Automations 改为 workspace-first。** 快捷命令多了工作空间层（`~/.cc-panes/workspaces/<name>/quick-commands.json`），解析顺序 全局 → 工作空间 → 项目；标签右键菜单与命令面板按活跃标签所属工作空间显示，新建默认落工作空间层。Automations 归属工作空间：编辑器先选工作空间、再在其项目里选工作目录（仍允许手填目录），列表带工作空间徽章。

### 新增

- **Cursor Bridge** — 一个 MCP 工具 `cursor_bridge`，让当前 CLI 绑定工作区、跑只读的项目理解、以及保持有边界的 Cursor Agent CLI 会话（`init` / `context` / `do` / `status` / `model` / `session`）。产品契约借自 Vanyangyang/cursor-bridge（sessionId ≠ taskId、范围冻结、requestId 幂等、CCE 形状的证据）。实现走官方 `cursor-agent` CLI，不走 CDP。`context` 启动 print worker 并加 `--mode ask`。持久 `do` 会话必须带 `readOnly` 或 `allowedPaths`，`continue` 不能扩大范围。登记簿**按工作空间**存放在 `~/.cc-panes[-dev]/workspaces/<name>/cursor-bridge/`；在 CC-Panes 里启动的 agent 不需要 `init`——工作空间和项目从调用方推断，每个 action 也都接受 `workspaceName` / `projectPath` 覆盖。设计见 `docs/96-cursor-bridge.md`。
- **工作空间记忆入口** — 右键工作空间 →「工作空间记忆」打开 Memory 管理的工作空间视图：按 `workspace_name` 列表 / 搜索，新建默认 `workspace` 作用域。
- **MCP 配置改为 workspace-first** — 项目级 MCP 不再写进 `<repo>/.claude/settings.local.json`。现在有两层：工作空间层 `~/.cc-panes/workspaces/<name>/mcp.json`（对其下所有项目生效，右键工作空间 →「工作空间 MCP」管理）和项目覆盖层 `<repo>/.ccpanes/mcp.json`（可提交，覆盖同名条目）。两层在启动时按会话合并注入：Claude 进 per-session `--mcp-config`，Codex 展开成 `-c mcp_servers.*`；启动档的启用 / 禁用列表对这些条目同样按名字生效。旧的 `settings.local.json` 只读保留，项目 MCP 页面顶部会提示尚未导入的条目并提供一键导入。代价：不经 CC-Panes 直接在项目里跑 `claude` 时看不到工作空间 MCP。
- **Plan 归档归拢到工作空间层** — Claude 计划文件的归档从 `<repo>/.ccpanes/plans/` 改到 `~/.cc-panes/workspaces/<name>/plans/`（不属于任何工作空间的项目落 `.ccpanes/.cache/plans/`），不再随 `.ccpanes/` 提交进仓库。Plan 面板同时列出三处（工作空间 / 项目缓存 / 旧位置），旧位置条目带角标；已提交进仓库的旧文件不自动搬。
- **命令面板有了按钮入口** — 状态栏右端新增命令面板按钮。终端聚焦时 Ctrl+K 等快捷键会交给终端，此前命令面板没有任何备用入口。
- **实验功能开关** — 设置 → 实验功能 下新增三个开关：技能市场、媒体生成、短剧制作台。**正式版默认全部关闭**（开发版默认全开），勾选后活动栏才出现对应入口。
- **短剧制作台（实验）** — 项目 → 分集 → 剧本 → 用已配置的 LLM Provider 一键拆分镜 → 每镜生图 / 生视频 / 批量重绘。生成复用媒体画布的节点与运行记录，结果同时出现在画布上。
- **媒体画布升级（实验）** — 节点右键菜单（删除 / 重命名 / 用相同输入重跑 / 打开产物 / 在文件夹中定位 / 断开连线）、画布缩放与无界坐标、画布模板、提示词副驾（用 LLM Provider 润色生成提示词）。媒体 Provider 改为独立类型 `media`：不注入 CLI 环境、不占默认凭证位、不会被误当成 CLI 的模型来源。sub2api 媒体接口改为真实异步任务协议（白名单请求体、Idempotency-Key、授权下载），可从 Provider 拉取模型列表。
- **Agent Chat 补齐 ACP 协议面** — ① 会话配置项（`configOptions`）接入：思维深度等选择器出现在 composer 底栏，改动经 `session/set_config_option` 下发、`config_option_update` 回同步，偏好按引擎记住；② 客户端 fs / terminal 能力打开：agent 可经 CC-Panes 读写文件、跑命令，工具卡里的 terminal 块实时显示输出与退出码；③ `authenticate`：引擎要求登录时按其广告的方式尝试，失败给出明确提示；④ 图片附件按 `promptCapabilities.image` 门控，不支持的引擎不再收到会被拒的 prompt。
- **技能市场** — 独立全屏页（活动栏 `Store` 图标，设置 → 工具 → Skills 也有入口）：精选横排 + 分类页签 + 搜索 + 一键安装。内容聚合三源：自维护 `skill-market/index.json`（30+ 条，偏中文场景，现已 `include_str!` 进二进制做离线基线，远端 `main` 可热更新）、`anthropics/skills` 自动发现、`skills.sh` 联网搜索。安装模型升级为**目录型技能**（`SKILL.md` + `scripts/` + `references/`）：GitHub API 一次列出仓库树，失败自动回退 jsDelivr 镜像；先落 staging 再 rename 到 `~/.cc-panes/skills/user/<id>/`，硬限 300 文件 / 30 MB。session prompt 注入时追加 `Skill directory: <路径>`，agent 能找到随包脚本。设计见 `docs/97-skill-market.md`。
- **项目技能管理** — 项目的「Skill 管理」标签分成两段。*Agent Skills* 管仓库里的 `SKILL.md` 技能目录，按各 CLI 扫描的根目录分组（`.agents/skills` 给 Codex/Cursor，`.claude/skills` 给 Claude Code，另有 `.cursor` / `.codex` / `.gemini`），每个技能带「哪些 CLI 能看见」的徽章。支持新建（自动补 frontmatter）、编辑、删除、跨根目录移动（让另一个 CLI 也能看到）、从已装用户技能 / CLI 本机已有技能 / 技能市场（直接下载进项目）/ 其他项目导入。*Slash 命令* 段保留原来的 `.claude/commands/*.md` 编辑器不变。
- **工作空间技能（workspace-first）** — 技能可以属于一个工作空间、对其下所有项目生效。存放在 `~/.cc-panes/workspaces/<name>/skills/`，是一个插件形态的目录，启动会话时按会话挂载，机制与内置 skill 完全一样（Claude `--plugin-dir`、Codex `skills.config`；不能挂载的 CLI 走 session prompt 注入），对仓库和用户 CLI 主目录零写入。右键工作空间 →「工作空间技能」用与项目技能同一套面板管理；技能市场新增「安装到」选择器，默认当前工作空间；项目技能导入把「工作空间」放在第一个来源；启动档多了「启用工作空间 Skill」开关。

## 0.12.9 - 2026-08-27

Canvas 多了第二类节点：媒体。另外 Cursor 从「只能启动」变成真正可编排的 CLI，终端也不再和 xterm 抢滚轮。

### 新增

- **画布上的媒体生成** — 图片与视频节点直接落在现有终端区域的 Canvas 里，与终端节点共享拖拽、缩放、快照和事件状态。节点主体用原生 DOM `img` / `video`，浏览器自带的解码、暂停、音量和无障碍能力全部保留，也不会为任何一帧走 canvas 复制像素；SVG 图层只负责节点之间的连线。节点与运行是两条独立记录，所以同一个节点可以反复生成并保留历史；Provider 通过能力注册表声明自己支持的操作、输入端口和输出类型，而不是所有人假设同一种 API 协议。任务状态归服务层管——lease、重启恢复、超时、重试、`clientRequestId` 幂等——且下游节点**不会自动串联**：跑一次是因为你让它跑。Canvas 快照升到 v2（只存位置、尺寸和视图设置，节点/运行/资产/边以 SQLite 为事实来源），同时仍能读 v1。设计文档见 `docs/22-media-generation-canvas-plan.md`。
- **Cursor 现在可编排，不只是能启动** — resume id 能进 `launch_history` 了（后台扫 `~/.cursor/chats/**/meta.json`，因为 Cursor 不像 Claude 那样能在启动前被塞一个 session id），启动时把 `ccpanes` MCP server 连同 url/token/launchId 写进 `~/.cursor/mcp.json`，状态判读只认保守短语（绝不看 spinner 单帧——它每帧重绘且随版本变化），WSL 恢复列表可用，`-p --output-format text` 让 Cursor 能当 print worker 使。在此之前这些一个都没有，意味着 Cursor 在启动器里看得见，却进不了任何派工流程。

### 修复

- **终端在和 xterm 抢滚轮** — 一段自己写的处理器在 alt-buffer 下把滚轮转成 `ESC[A`/`ESC[B`，而 xterm 6.0 本来就做了这件事，且做得更对：它按「应用有没有请求滚轮鼠标事件」门控，并按 DECCKM 编码（应用光标键模式下发 `ESC O A`）。我们两条都没做，还把监听挂在 xterm 绑定的同一个元素上——`stopPropagation()` 挡不住同一节点上的其它监听器——于是每次滚轮两个处理器都跑。开了鼠标上报的应用（grok、opencode）收到真实 SGR 鼠标报告**外加**多余的方向键；没开的（codex、vim）收到两个方向键而不是一个。在 grok 的 plan 审批界面里，那些多余方向键落到键盘焦点所在的 prompt 上，翻的是输入历史而不是滚动 plan。这段已删除，滚轮重新交回 xterm。
- **侧栏启动菜单里仍会列出当前不可用的 CLI。**

### 变更

- **全屏 TUI 拿回完整的滚轮距离** — xterm 在发出鼠标报告前会抑制小像素增量，于是自己处理滚动的 TUI 一格只能挪一行。现在滚轮距离被解算成行数，并按这个行数补发等量的 line-mode 滚轮事件。三类输入分开处理，因为它们的物理含义不同：带刻度的滚轮走对数压缩加连滚加成；触控板像素流 1:1 映射且结转不足一行的余量（压缩会让惯性滚动失真，丢掉余量则慢速拖动完全滚不动）；行/页模式本身就是行数。整条链路走 xterm 官方的 `attachCustomWheelEventHandler` 而不是另起一个抢事件的监听，并在三种情况下完全不介入：应用没开鼠标上报、按住 `Shift`（终端惯例的绕过手势）、以及它自己补发出来的事件。

## 0.12.8 - 2026-08-26

Canvas Mode 上线——把 agent 之间实际在说什么变成看得见的空间关系。另外修了四个缺陷，形态完全一致：功能都在、UI 都显示正常、全程零报错，所以每一个都已经坏了很久没人发现。其中三个共享同一个成因：**进程拆分之后没人重新核对的边界**。共享 MCP server 由 app 启动、会话却由 daemon 创建，注入表因此恒为空；ACK 队列排空时用了无条件通知，一笔回执就把一整个 tokio worker 永久钉在 100%；而 stdio 类 MCP server 拿到的是 null 的 stdin——那正是通知它退出的信号。

### 新增

- **Canvas Mode** — 终端区域内与普通 pane 布局并列的第二种布局，不是替代品。终端卡片在独立空间里可拖拽、可调整尺寸，卡片之间的管道只反映真实的 `dispatch` / `message` / `report` 事件——不从终端文本猜测关系，也不会因为 worker 处于 `running` 就一直播放粒子。任务摘要和状态标签渲染在卡片边缘，不遮挡终端内容。执行模型完全不动：还是同一批 pane、tab、PTY 和 xterm 实例，显示状态存在独立的 store 里，切换视图不会打扰正在跑的会话。编排面板继续负责任务列表、详情和通知，Canvas Mode 只负责实时的空间关系与通信反馈。设计文档见 `docs/92-canvas-mode-design.md`。

### 修复

- **共享 MCP server 一个都进不了新会话** — 端口在监听、UI 显示健康，可生成出来的 `mcp-<sessionId>.json` 里只有 `ccpanes` 一个。server 子进程由 app 启动（`start_all` 全仓库只有 `lib.rs` 一个调用点），而会话——以及那份列出它 MCP server 的配置文件——是在 daemon 里创建的。daemon 自己那份 `SharedMcpService` 的 `running` map 因此恒空，而 `get_running_servers_urls()` 要求 `status == Running` 才注入，于是每次都返回空表，adapter 的注入循环一次都没执行过。现在 running URL 表经既有的 control 通道推给 daemon 缓存，形态照抄 `hiddenSessions`（全量覆盖、连接建立补发、best-effort）。下发走 `TerminalBackend` 的默认方法——与 `outputAck` 同一条既有路径——因为 `DaemonConfig` 只持有 trait 对象，够不着具体的 service。三条不变式撑住这个设计：control 断开即清缓存，因为注入一个已死的端点会让每次工具调用都卡在连接上（比不注入更糟）；handler 按 `is_desktop` 门控，手机端或 web 端断开不能抹掉桌面推来的表；启动配置的过滤规则对推送来的表同样生效。
- **一笔回执就能把一个 tokio worker 永久钉在满核，且完全静默** — 表现是应用间歇性失去响应、`browser_evaluate` 报 `CDP method timed out`。活体采样显示一个 `tokio-runtime-worker` 在启动后 1.1 秒就烧到 99.5% 单核、重启必复现，30 次指令指针采样有 28 次落在 `ZwWaitForAlertByThreadId` 与 `ZwRemoveIoCompletionEx`，栈指针在四个值之间循环——是循环不是挂死。而 I/O 计数只有每秒约 92 次，排除了 syscall 风暴。`drain_output_acks` 用 `send_modify` 排空队列，而这个 API 是**无条件通知**：写回一个空 map 也会把接收方的 `changed()` 重新置位，加上调用方在排空**之前**就已经 `mark_unchanged()`，这次通知没有任何人消费——于是下一轮立刻就绪、再排空一个空 map、future 从此不再回到 `Pending`。最小复现三秒跑 1400 万次，换成 `send_if_modified` 后是 6 次。CDP 超时只是症状：它的定时器与 oneshot 唤醒都排在一个已被占满的运行时后面。
- **共享 MCP server 在连接建立 40 毫秒后自杀** — `docs/70` 记录过、挂了两个版本的待修项。`spawn_server_process` 对所有 bridge 模式一律给 `Stdio::null()` 的 stdin，而 stdio 类 MCP server 把 stdin 的 EOF 当作退出信号；三次重启后熔断器把它们彻底停掉。用户看到的现象完全不像「MCP 挂了」——agent 只是看不见那套工具，然后静默改用别的。现在 `McpProxy` 类拿到的是 piped 的 stdin，句柄存在 `ServerRuntime` 里；句柄一旦 drop 本身就是 EOF，所以「持有它」才是修复本身。
- **每次组合输入都抛 `TypeError: Illegal invocation`** — 终端的组合输入恢复调度器把 `requestAnimationFrame` 与 `cancelAnimationFrame` 的裸引用存成了对象属性，这会让它们脱离 `window`，WebView2 直接拒绝调用。而这个 handler 绑在 `compositionend` 上，于是每打一次中文或日文就触发一次，日志被 `[frontend-crash]` 刷屏。现在两个方法都用箭头函数包起来，顺带把全局查找推迟到调用时，模块在没有浏览器全局的环境里也能安全导入。
- **生产构建破坏了 xterm 的 `requestMode`**，另有类型检查门禁在 `closedTabsUndo` 上一直是红的——`current()` 要求 `Draft<T>`，而 `isDraft` 只在运行时窄化。两处都补上了：构建新增 `verify-xterm-build` 步骤，类型断言只作用在「已确认是 draft」那条分支上。


- **共享 MCP server 一个都进不了新会话** — 端口在监听、UI 显示健康，可生成出来的 `mcp-<sessionId>.json` 里只有 `ccpanes` 一个。server 子进程由 app 启动（`start_all` 全仓库只有 `lib.rs` 一个调用点），而会话——以及那份列出它 MCP server 的配置文件——是在 daemon 里创建的。daemon 自己那份 `SharedMcpService` 的 `running` map 因此恒空，而 `get_running_servers_urls()` 要求 `status == Running` 才注入，于是每次都返回空表，adapter 的注入循环一次都没执行过。现在 running URL 表经既有的 control 通道推给 daemon 缓存，形态照抄 `hiddenSessions`（全量覆盖、连接建立补发、best-effort）。下发走 `TerminalBackend` 的默认方法——与 `outputAck` 同一条既有路径——因为 `DaemonConfig` 只持有 trait 对象，够不着具体的 service。三条不变式撑住这个设计：control 断开即清缓存，因为注入一个已死的端点会让每次工具调用都卡在连接上（比不注入更糟）；handler 按 `is_desktop` 门控，手机端或 web 端断开不能抹掉桌面推来的表；启动配置的过滤规则对推送来的表同样生效。
- **一笔回执就能把一个 tokio worker 永久钉在满核，且完全静默** — 表现是应用间歇性失去响应、`browser_evaluate` 报 `CDP method timed out`。活体采样显示一个 `tokio-runtime-worker` 在启动后 1.1 秒就烧到 99.5% 单核、重启必复现，30 次指令指针采样有 28 次落在 `ZwWaitForAlertByThreadId` 与 `ZwRemoveIoCompletionEx`，栈指针在四个值之间循环——是循环不是挂死。而 I/O 计数只有每秒约 92 次，排除了 syscall 风暴。`drain_output_acks` 用 `send_modify` 排空队列，而这个 API 是**无条件通知**：写回一个空 map 也会把接收方的 `changed()` 重新置位，加上调用方在排空**之前**就已经 `mark_unchanged()`，这次通知没有任何人消费——于是下一轮立刻就绪、再排空一个空 map、future 从此不再回到 `Pending`。最小复现三秒跑 1400 万次，换成 `send_if_modified` 后是 6 次。CDP 超时只是症状：它的定时器与 oneshot 唤醒都排在一个已被占满的运行时后面。
- **共享 MCP server 在连接建立 40 毫秒后自杀** — `docs/70` 记录过、挂了两个版本的待修项。`spawn_server_process` 对所有 bridge 模式一律给 `Stdio::null()` 的 stdin，而 stdio 类 MCP server 把 stdin 的 EOF 当作退出信号；三次重启后熔断器把它们彻底停掉。用户看到的现象完全不像「MCP 挂了」——agent 只是看不见那套工具，然后静默改用别的。现在 `McpProxy` 类拿到的是 piped 的 stdin，句柄存在 `ServerRuntime` 里；句柄一旦 drop 本身就是 EOF，所以「持有它」才是修复本身。
- **每次组合输入都抛 `TypeError: Illegal invocation`** — 终端的组合输入恢复调度器把 `requestAnimationFrame` 与 `cancelAnimationFrame` 的裸引用存成了对象属性，这会让它们脱离 `window`，WebView2 直接拒绝调用。而这个 handler 绑在 `compositionend` 上，于是每打一次中文或日文就触发一次，日志被 `[frontend-crash]` 刷屏。现在两个方法都用箭头函数包起来，顺带把全局查找推迟到调用时，模块在没有浏览器全局的环境里也能安全导入。


## 0.12.7 - 2026-08-23

主要是 macOS 版本。两个各自独立的缺陷叠在一起，导致 mac 上应用快捷键基本全都不响应、终端完全没有右键菜单——两者都趴在早已标记为"做完"的功能底下，也都逃过了测试：jsdom 报告的平台不是 mac，出问题的那几条分支从来没被执行到。另外终端输出通路补上了端到端流控：渲染层的窗口 Rust 侧看不见，背压此前只是被挪了位置、从未被真正度量；现在刷屏的进程会被自己的输出限速，而不是由 IPC 队列碰巧能吞下多少决定。

### 新增

- **终端输出投递记账** — 写入流控窗口只在渲染进程内生效，队列压力只是从 xterm 前移到 WS/Tauri IPC 层，并没有消失。合批 channel 的深度也测不出来：两个 emitter 都不阻塞，WebView 卡住时深度恒为 ~0，积压全在 IPC 队列里。唯一能反映下游消费速度的水位是"已 emit 未确认的字节数"，现在这个量被端到端记了下来（累计值 + max-merge，重试下天然幂等）。信用归还在**消费点**——chunk 被 xterm 解析完，**或**被任何一条丢弃路径丢掉——因为在入队时就确认，等于告诉上游"我消化完了"而实际只是"我收到了"。水位超过上限后 PTY 读循环随即暂停：刷屏的子进程填满内核缓冲后阻塞在自己的 `write()` 上，被自己的输出限速。三条独立路径保证它一定会恢复（ACK 排空到下限、5 秒失效超时、会话取消）；回执链路是真断了的话，退化成快照重建而不是龟速终端。没有回执通道的客户端（web 模式、旧版前端）根本不会被暂停——闸门一直开着，直到第一个 ACK 证明回程存在。SSH 会话同样永不暂停:同主机多终端共享一条 ssh2 传输,停读一个会拖垮其余。翻 `PRODUCER_FLOW_CONTROL_ENABLED` 常量即可停用闸门,不必回滚整版。

### 修复

- **mac 上终端聚焦时应用快捷键全部失效** — 而终端是主界面，几乎总是聚焦状态。两个缺陷叠加：`parseKeyEvent` 把 `ctrlKey` 和 `metaKey` 都归一化成 `Ctrl` 前缀，⌘W 与 ⌃W 到匹配阶段已经分不出来；终端放行名单接着把七个最常用的绑定（close-tab、new-tab、toggle-sidebar、command-palette……）让给了 readline。那份名单是为「Ctrl 即应用修饰键」的平台写的，在 mac 上把 ⌘ 组合一起吞了——可 ⌘W 对 readline 毫无意义。现在让行改在事件层按真实 ⌃ 键判断，不再看归一化后的字符串，于是 ⌘ 绑定照常触发，⌃C/⌃D/⌃A/⌃E 仍然进 shell。另一个问题是 Option 属于组字键：⌥L 送到的是 `¬`、⌥1 是 `¡`，比对不上任何绑定，toggle-layouts、voice-input、switch-layout-1..9 因此同样是死的。现在按下 Alt 时改读物理键位 `code`，不按 Alt 仍以键盘标签为准，AZERTY 与 Dvorak 布局不受影响。而 UI 一直把 `Ctrl+` 显示成 ⌘——它始终在承诺一个按下去没反应的键。
- **mac 上终端没有右键菜单** — 原生菜单拦截器对 `contextmenu` 调了 `stopImmediatePropagation`，而 Radix 靠冒泡的 `onContextMenu` 打开，菜单永远弹不出来；当时的应对是干脆在 mac 上不挂菜单。现在拦截器对 `contextmenu` 只调 `preventDefault`（仍然压制原生菜单）并放行传播，菜单在全平台启用。
- **终端文字贴着面板边框** — 宿主元素一条内边距都没有，xterm 从容器原点起画，首列字形直接顶着边框。内边距挂在宿主而不是 `.xterm` 上：FitAddon 按父元素的 content box 反推列数，行列数会跟着收；挂在 `.xterm` 上则视口连同滚动条一起内缩。纵向只给 4px——上下每多 8px 就可能被 FitAddon 的向下取整吃掉一整行可见内容。
- **通知中心的「全部」不含系统通知** — 而铃铛徽章与折叠条数的是全量未读（含系统事件）。未读全是系统事件时就出现「徽章显示 7 条、列表却是空的」：看得见计数却找不到内容，也就无从判断该不该清。降噪交给「系统」这个子集筛选表达，不靠让「全部」名不副实。
- **无订阅者时暂存的输出可能被从转义序列中间切断** — 溢出策略是丢掉待发缓冲最旧的一半，会把 VT 转义序列拦腰截断，半截序列进 xterm 就是花屏。这正是 desync 契约明令禁止的"绝不掐 VT 流中段"，而 daemon 镜像流通路对同一风险早已用"整段跳过 + 快照重放"正确处理了。现在前端这条对齐到同一契约。上限同时从 chunk 数改为字符数——1000 个 chunk 可能是 256 B 也可能是 1 GB。

### 变更

- **后台终端积压改为全局共享预算** — 此前每个隐藏缓冲各占 512 KB，18 个后台标签就是 9 MB 上限：N 个会话 N 份独立上限。现在总量封顶 2 MB，后台标签越多每份越小。这是收紧不是放松：只有一个后台标签时它照样拿满 512 KB。代价是溢出更频繁、快照重放更多，属预期取舍——重放一次的成本远低于常驻 9 MB。
- **侧栏改为紧凑排布** — 收紧行内边距、缩小图标、统一徽章形状，整列信息密度提上来。两处不只是好看：分支徽章成为行内唯一可收缩项，项目名留了保底宽度，窄侧栏下不会再把名字截成 `cc…`；worktree 计数徽章从 `title` 改用 `aria-label`，读屏能报出来，也不再弹原生 tooltip。展开区改用左侧竖线加缩进，不再每层套一个卡片。

## 0.12.6 - 2026-08-22

维护版本。主体是一条线索拉到底：一份"面板乱码"的报告引出了对本地 PTY 通路的审查，翻出五个各自独立的正确性 bug——前三轮竞品差距扫描一个都没抓到，因为那些扫的是"缺什么功能"，而这五个全都趴在已经标记为"做完"的功能底下。另外加了 Pi / Oh My Pi 支持。

### 新增

- **Pi 与 Oh My Pi (omp) CLI 支持** — 两者都作为一等 CLI 适配器接入（启动、恢复、会话发现、上下文探测），可以像 Claude/Codex 一样被派发和编排。

### 修复

- **本地会话跑在非 UTF-8 locale 下** — macOS 从 Finder/Dock 启动的 GUI 应用不继承 shell 的 `LANG`/`LC_*`，于是每个本地 PTY 都跑在 `LC_CTYPE=C` 下，任何按 locale 计算多字节宽度的程序（典型是 TUI 排版用的 `wcwidth`）都会把中文算错——四个汉字 `wc -m` 数出 12。此前只有 WSL 通路注入了 locale，本地一处都没有。现在继承到的 locale 不是 UTF-8 时补 `LANG=C.UTF-8`，**只动 `LANG`，绝不写 `LC_ALL`**——后者是 POSIX 全局覆盖，会一并压掉用户自己的 `LC_TIME`/`LC_COLLATE`。若用户的非 UTF-8 `LC_ALL`/`LC_CTYPE` 压过了注入，记一条警告而不是静默失败。
- **跨 PTY 分块的转义序列丢了前半截** — 纯文本输出缓冲用无状态剥离器逐块剥 ANSI。它已经会跨块携带不完整的 UTF-8 字符和不完整的**行**，唯独不带不完整的**转义序列**：开头的 `\x1b[38;2;24` 被整段吞掉，尾巴 `8;248;242m` 就以字面文本冒出来。有一个会话的缓冲里躺着 552 个这种碎片。现在序列会跨边界携带，携带上限按类型分档（CSI 128 B，OSC/DCS 4 KiB——一条 120 字符的 OSC 8 超链接本身就有 127 B，OSC 52 剪贴板载荷更是上千字节）。
- **查询应答被回显成可见乱码，还污染下一个程序的 stdin** — 前端通过写 PTY master 来回答终端查询（CPR、设备属性、kitty 键盘、OSC 4/10/11）。行规程处于熟模式时，这次写入会被原样回显（`^[[1;1R`），**同时**还排进从端输入队列，被下一个读 stdin 的程序吃掉。现在 TTY 处于真正的熟模式时抑制应答，判定用 master fd 上的同步 `tcgetattr`——刻意不用异步探测，因为"推迟一次应答"正是让后一次应答插队的原因。判据要求 `ECHO` 和 `ICANON` **同时**成立：`ICANON` 关掉时程序确实读得到应答，此时抑制反而会把它挂死。判不出来就一律不抑制。
- **多行提交可能被逐行提交** — `submit_to_session` 只在观测到 DECSET 2004 时才加粘贴括号，否则发原文——而原文里每个换行到了 TUI 就是一次回车。Windows ConPTY 从不转发这个模式，代码里也没有开机等待，所以启动后立刻注入的 prompt 会和它抢跑。比拆散消息更糟的是：**停在 agent 输入框里的草稿会被第一个换行直接提交出去**。现在发往运行 TUI 输入框的会话的多行提交一律加括号。
- **字节缺口后终端状态被搁浅** — 失步恢复拿不到快照时直接返回、什么都不写。保留受损画面是对的，但状态没跟着一起保留：收尾加粗的 `CSI 22m`、离开备用缓冲的 `CSI ?1049l`，都可能正好落在丢失的那段里，后面所有内容都继承了它。现在放弃路径会发一个窄接地——`CAN` 加一个 SGR 复位。用 `CAN` 而不是裸 `ESC`，因为 xterm 对 OSC/DCS/APC 只认 `0x18`/`0x1a` 作终止符，`ESC` 反而会把那条截断的序列**执行掉**：半截 OSC 0 会改窗口标题，OSC 52 会写剪贴板。
- **跨面板的 WebGL 字形图集损坏** — xterm 在配置相同的终端之间共用一份字形图集，但每个面板各自持有顶点模型，于是某个面板触发图集重建后，其他面板还在按旧坐标采样（表现为大片黑区夹着零星彩色碎片，只有整屏重绘才恢复）。中文会持续触发它，因为每出现一个新汉字就是一个新字形。现在图集结构变化时所有存活的 WebGL 终端一起刷新；重绘失败保留待刷标记而不是丢弃；`onRender` 作为第三个触发时机，兜住 IntersectionObserver 看不见的面板。
- **MCP 派发的 worker 重启后无法被重新接管** — 编排器的几条创建路径写出的溯源行带空的出生锚点（PTY 先于前端选定落位而存在），而这些行永远修不好——写入方是 `ON CONFLICT DO NOTHING`，回填又只找"整行缺失"的情况。现在锚点在创建时预分配、daemon 侧兜底，迁移 v35 回填存量行——**只在观测行确实同时提供了两个锚点时才填，绝不编造**。
