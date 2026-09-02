# 更新日志

[CHANGELOG.md](CHANGELOG.md) 的中文版。GitHub Release 说明与应用内更新提示都从这份文件注入
（`.github/scripts/extract-changelog.mjs`），所以**发版前必须补上对应版本的条目**——缺了会在
`validate-version` 里直接失败，构建根本不会启动。

两份是人工同步的，条目一一对应；改英文版时顺手改这里，逐条 diff 能看出漏了哪条。
0.12.6 之前的版本只有英文版。

## 0.12.10 - 2026-09-01

### 新增

- **技能市场** — 独立全屏页（活动栏 `Store` 图标，设置 → 工具 → Skills 也有入口）：精选横排 + 分类页签 + 搜索 + 一键安装。内容聚合三源：自维护 `skill-market/index.json`（30+ 条，偏中文场景，现已 `include_str!` 进二进制做离线基线，远端 `main` 可热更新）、`anthropics/skills` 自动发现、`skills.sh` 联网搜索。安装模型升级为**目录型技能**（`SKILL.md` + `scripts/` + `references/`）：GitHub API 一次列出仓库树，失败自动回退 jsDelivr 镜像；先落 staging 再 rename 到 `~/.cc-panes/skills/user/<id>/`，硬限 300 文件 / 30 MB。session prompt 注入时追加 `Skill directory: <路径>`，agent 能找到随包脚本。设计见 `docs/97-skill-market.md`。
- **项目技能管理** — 项目的「Skill 管理」标签分成两段。*Agent Skills* 管仓库里的 `SKILL.md` 技能目录，按各 CLI 扫描的根目录分组（`.agents/skills` 给 Codex/Cursor，`.claude/skills` 给 Claude Code，另有 `.cursor` / `.codex` / `.gemini`），每个技能带「哪些 CLI 能看见」的徽章。支持新建（自动补 frontmatter）、编辑、删除、跨根目录移动（让另一个 CLI 也能看到）、从已装用户技能 / CLI 本机已有技能 / 技能市场（直接下载进项目）/ 其他项目导入。*Slash 命令* 段保留原来的 `.claude/commands/*.md` 编辑器不变。

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
