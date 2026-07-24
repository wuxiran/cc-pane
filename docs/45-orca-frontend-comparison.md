# 45. Orca 前端对比：视觉·交互·状态·细节四维分析

> 姊妹篇：[docs/43](./43-orca-competitor-analysis.md) 覆盖编排/后端/原语；本篇只谈前端（renderer vs web/）。
> 来源：2026-07-24 六路并行源码探索（我方总量基线 / Orca 架构与设计系统 / Orca UX 打磨 / Orca 核心界面深剖 / Orca 其余界面 / 我方逐界面基线），另亲读 Orca `docs/STYLEGUIDE.md` 与我方 docs/22 核实。快照：`../references/orca`。
> 配套改进计划见 §6（本文自包含，逐项含文件/依赖/验收）。
> **rev.2**：经 WSL Codex 只读评审（13 条发现：高 2/中 9/低 2），全部吸收——修正了 StatusBar 误判、滚动条已修事实、spinner 计数与范围、快捷键/Section 计数、i18n 定性、hidden delivery gate 依赖定级等。

**结论速览：**

1. **Orca 前端的"好"不是像素，是纪律的复利**：314 行 UI 风格宪法 + 三道 AST 机器护栏 + 行数棘轮 CI + 性能模式（共享 spinner 时钟/parked terminal），不是某个惊艳组件
2. **我方基建是伪差距**：token 体系/动效规范/i18n 对等/TabBar 交互面/命令面板均不落下风，个别反超
3. **真差距四处**：成文决策表（品味没固化）、会话行信息密度与状态可视化统一、git 审查区（他们最重的 398 文件面 vs 我们只读展示）、已知缺陷欠账 + 无限动画成本
4. **我方独有界面 13 项是反超资产**，Local History/Provider 中心/记忆管理/迷你模式/编排控制台等他们全没有
5. 本文只挑"个人项目养得起"的模式进改进清单；Orca 是团队日发 7 版堆出来的面积，比面积必输，比纪律可赢

---

## 1. 基线数据对照

| 维度 | Orca renderer | CC-Panes web/ |
|---|---|---|
| 规模 | 4621 文件 / ~99 万行 | 692 文件 / ~11.8 万行 |
| 组件目录 | components/ 3371 文件 | components/ 393 文件（185 生产组件） |
| 测试:生产 | 极高（几乎每逻辑单元配 .test） | 1.5:1（283 测试文件） |
| 可重映射快捷键 | **85** 个动作（keybindings.ts 2320 行，每默认绑定带 `// Why:`） | 35 个默认绑定 ID（含编号式 tab/layout 动作；数字应从 bindings 数组生成防漂移） |
| 设置面板 | **34 pane + 68 个搜索索引文件** | 13–14 Section（按平台），不可搜索 |
| i18n | **5 语 × ~23600 键** + 三道 AST 护栏 | 双语 15 namespace，逐文件行数与键路径完全一致（**小范围双语一致性优势**；工程护栏纵深仍落后，见 P1-1） |
| 对话框 | ~69 个 | ~25 个（AppDialogs 10 挂载点 + 分散） |
| 样式真源 | main.css 3471 行 | index.css 757 行 |
| 动画方案 | 纯 CSS + tw-animate-css（无 JS 动画库） | 同（无 framer-motion）——路线一致 |
| 状态管理 | 单一 zustand 40+ slice spread 合并、useShallow | 41 个独立 store + 原子 selector |
| 路由 | 无路由库（store 驱动视图） | 同 |
| 虚拟化 | @tanstack/react-virtual（diff 区/文件列表/会话列表） | **零**（弱点） |
| 组件级 memo | 热点组件有纪律 | 仅 9 处（靠 hook 记忆化 + 原子 selector 撑） |
| 巨石治理 | max-lines 行数棘轮 CI（只减不增），WorktreeCard 1937 行是唯一豁免且注释说明 | usePanesStore 3033 / TerminalView 2246 / LaunchProfilesPanel 2094 无约束 |

定性：体量差 8 倍是团队人力的直接产物，不是质量差 8 倍。值得比的是每行代码背后的纪律密度——这恰是能免费抄的部分。

## 2. 设计系统对照

**Token 架构——结构同构，深度有差：**

- Orca 三段式：`@theme inline { --color-*: var(--*) }` 映射进 Tailwind → `:root`/`.dark` 原值 → **派生层**（radius 全部 `calc(var(--radius)*k)` 等比、色彩一律 `color-mix` 不新增 hex）
- 我方：Tailwind 4 CSS-first 单一真源 + shadcn 语义层 + 自建 `--app-*` 60+（三级明度/发丝边框/三级 elevation/状态色四分类/动效 token 120/160/240ms + reduced-motion 降级）——**结构不输**
- 差在**领域深 token**：他们有 `git-decoration-*`（镜像 VS Code 七态）、`git-graph-lane-1..5`（提交图五色泳道）、终端 pane 标题**明暗双套**（标题浮层跟随其下终端表面的明暗取色而非应用主题——保证叠在任意主题终端上的对比度）、`editor-surface`（Monaco 面板深色下略深贴 VS Code 惯例）

**约束机制——各有先手：**

- 他们：`STYLEGUIDE.md` 314 行宪法，每 PR 以 "UI Quality Bar" 回引；色彩角色表、原语分叉表、按钮层级表全部表格化可查
- 我们：`designTokens.test.ts` 静态扫描防硬编码色回潮（**机器护栏我们反而先有**）；docs/22 是宪法雏形但缺五大件：原语选择决策表、in-flight 反馈时长分级、UX 评审 rubric、列表行三态约定、跨平台规则

**直接可抄四条（零风险）：**

1. **主题切换瞬时**：翻转大量 CSS 变量时先挂 `.theme-transition-disabled` 禁 transition（否则 UI 各部分异速淡入）
2. **阴影三级封顶**成文（我们事实上也是三级，但没立法禁止第四级）
3. **琥珀 = "需注意"全局约定**：tab 未读薄雾（`bg-amber-500/10`）、卡片未读点、托盘注意图标、浮动面板 attention 点全用同一琥珀——连托盘的 BGRA 位图都手画对齐 token。一种颜色承载一种语义，贯穿到像素层
4. **状态泳道语义让位**：卡片左缘同一条 5px 泳道在"活动状态点 / PR 状态图标 / 分支图标 / 未读点"间按优先级智能切换，不加宽不并列——信息密度不靠堆位置

## 3. 逐界面对照矩阵

> 每界面三行：Orca 构成 → CC-Panes 现状 → 差距定性（真差距 / 伪差距 / 反超）。

### 3.1 会话/任务卡片（核心界面）

**Orca `WorktreeCard.tsx`（1937 行 + 30 个子文件）**：左状态泳道 + 内容列。信息元素全清单：仓库身份 chip、SSH/Runtime 主机图标（断连变红）、可内联重命名标题（未读加粗/已读变暗）、primary/sparse/游离 HEAD/冲突操作徽章、**CacheTimer**（Claude prompt-cache 5 分钟 TTL 倒计时，多 tab 取最紧急——过期即 10x 成本，给用户续用决策）、**PR 徽章**（GitHub checks Passing/Failed + Merged/Draft/Open）、**端口徽章**、issue/comment/automation 徽章、**内联 agent 树**（父子谱系折叠、点击直达 tab+pane、未访问加粗、访问即 ack）、lineage 子卡片 chip（父子 worktree）。交互巧思：**按住 Alt 才在 hover 露出删除按钮**（防误删）、hover 才拉取 review/issue 数据（隐藏不轮询省配额）、拖到另一卡片建父子关系。三套密度模式（常规/紧凑/新风格）。

**CC-Panes**：三件套分担——`OrchestratorTaskCard`（249 行：角色 emoji+左边框着色、状态、进度条、git 分支+worktree 徽章、worker 计数、完成摘要、失败展开退出码）+ **`CurrentActivityBadge`**（工具级实时活动：💻Bash/🔧Edit + 命令摘要 + 运行时长每 15s 刷新——**表达粒度比 Orca 细**，他们只到状态级）+ `SessionsView` 会话行（**仅图标+状态点+标题，无时间/CLI/分支——信息最薄的一环**）。

**定性**：结构性平手、局部各有胜负。我们的工具级活动徽章、角色层级、进度条是反超；**真差距 = SessionsView 信息密度 + 卡片三缺件（CacheTimer/PR 徽章/端口徽章）+ 琥珀未读语义缺失**。→ 改进 P1-3、P2(CacheTimer)。

### 3.2 Tab 栏

**Orca**（83 文件）：三种 tab 类型（terminal/editor/browser）分派渲染;tab 上有 agent 图标、**未读琥珀薄雾**（整块背景而非小红点）、pin、**10 色标记**、`data-agent-activity-status` 实时属性;**搜索式创建菜单**（输入模糊匹配或直接敲 URL/路径创建）、快速启动 agent 项;pointer-up 才激活防拖拽误切、中键关闭、拖拽只动插入指示条。

**CC-Panes `TabBar.tsx`**（807 行）：**三档密度自适应**（≤3/≤6/>6）、状态点、**会话绑定标志**（Link2 绿=可 resume/灰=未绑定，点开 SessionBindDialog——他们没有的元素）、pin/star/#N 编号独立渲染、双击重命名、6 种分屏操作、**跨布局移动 + 弹出独立窗口**（他们没有）、滚轮横滚+自动滚入。

**定性**：**平手偏我方**——交互覆盖面我们更宽；可抄两小件：未读琥珀薄雾、搜索式创建菜单。

### 3.3 终端 chrome

**Orca**：pane 标题是浮层（绝对定位叠在 xterm 上），**明暗双套 token 跟随终端表面取色**;标题栏动作簇（续接会话/chat 切换/Split/关闭）;**浮动终端面板**（1912 行）——独立于主布局、任意界面可唤出的可拖拽缩放悬浮终端窗，自带 tab 栏与未读 attention 点。

**CC-Panes**：Panel 标题栏 + PanelEmptyActions 空态快捷动作 + StarredPanel 收藏镜像宫格;**MiniView 迷你模式**（玻璃拟态会话状态宫格+置顶）在"随时瞄一眼"场景对位浮动面板，形态不同各有理。

**定性**：伪差距为主。明暗双套 token 思路记档（若做壁纸上的浮层元素会用到）。

### 3.4 右侧栏审查区 —— **最大单体差距面**

**Orca right-sidebar/**（398 文件，全 renderer 最重）：activity bar（7 tab，位置 top/side 可切）+ 面板区。
- **Source Control（8214 行）**：Staged/Changes/Untracked 分组虚拟文件列表、行级 stage/unstage/discard、commit 文本域 + **AI 生成 commit message**、Commit/Commit&Push/Sync 智能主按钮、创建 PR/MR 表单、hosted review 操作
- **Checks**：PR 检查 runs → jobs → steps 逐级状态、日志尾部、**Fix with AI**（失败 check 一键交给 agent 修）
- **AI Vault**：agent 会话历史虚拟列表（搜索/过滤/分组/scope），行级 **Resume**（原/当前 worktree 恢复）
- **AI Diff 批注闭环**（招牌交互）：diff 行内 "Add note for the AI"（Monaco 装饰器 + 自增高浮层、多行选区、IME 安全）→ 批注卡片 → 工具栏 Sparkles "AI notes" 计数徽章（预览/Copy/Clear）→ **Send 菜单按 This file/All unsent 发给运行中 agent** → 已发送标记。审查-修复闭环全在 diff 界面完成

**CC-Panes**：`ExplorerGitSection`（343 行，**只读**分支+变更列表）+ `GitTimelinePanel`（提交时间线+自研 DiffView）+ Local History。无 stage/commit UI、无批注、无 Fix with AI;resume 有（TabBar 绑定标志 + launch history）但不在 git 语境里。

**定性**：**真差距，且是四维里"细节打磨+交互效率"的最大集中体现**。但属重投入面——P2 单独立项评估，本文先把交互流记全（上文即规格素材）。值得注意：他们这 398 文件服务的"人审查 agent 产出"工作流,与我们"leader-agent 审查 worker 产出"的编排哲学不同——我们可以选择把审查闭环建在编排控制台而非 git 面板,这是差异化机会而非纯补课。

### 3.5 Diff 查看器

**Orca `CombinedDiffViewer`**（2145 行）：四模式（全部/vs 分支/某 commit/未提交）、左文件树（当前高亮+已阅标记）+ 右虚拟化 diff 区、Inline/SideBySide 切换、Wrap 切换、Expand/Collapse All、渐进加载 30s 超时、行内编辑保存、冲突文件单独审查入口。Monaco 驱动 + model 手动释放防泄漏。

**CC-Panes**：自研 `DiffView`（hunk 渲染+行内高亮+二进制处理），Local History 与 GitTimeline 复用。轻量完整，但无 SideBySide/已阅标记/虚拟化。

**定性**：半真差距。自研路线本身合理（体积小、两处复用），缺的是大 diff 场景的工程（虚拟化、渐进加载）——等 Local History 出现大 diff 卡顿再升级，先记录。

### 3.6 状态栏

**Orca `StatusBar`**（2534 行）：**provider 用量段**（rate-limit 进度条、8 家 provider、窄栏降级单字母徽章）→ 点开**账号切换器**（host/WSL 分组、切账号后一键重启受影响会话）;右段资源管理器（CPU/内存/会话数）、端口、SSH、更新、宠物、浮动终端触发;右键勾选显示哪些段。

**CC-Panes**：**已有状态栏**（`web/components/StatusBar.tsx`，由 `layout/AppShell.tsx` 挂载）——含工作空间、活跃终端、更新与窗口工具段。缺的是 provider 用量段、账号切换器、资源指标段。

**定性**：半真差距——位面已存在，缺的是内容段。P2 若做,**扩展现有 StatusBar 组件而非新建位面**;provider 用量段与账号切换是最有价值的两件（贴我们 Provider 中心的既有强项）。（rev.2 修正：初稿误判"无状态栏"，评审纠错。）

### 3.7 Chat 视图

**Orca native-chat/**（154 文件，完整产品级）：结构化事件流组装的原生聊天视图（非抓 TUI），与终端 `setTabViewMode('terminal'|'chat')` 一键互切;工具审批卡、@文件补全、附件/图片粘贴、模型切换、分页/自动滚动。

**CC-Panes**：无对位物（SelfChat 是内嵌终端会话，形态不同）。

**定性**：**明确不做**（43 号文档结论的前端面）：终端 TUI 是我们的形态选择，OSC/hook 状态机的深耕都建立在 TUI 之上;做 chat 视图等于开第二条渲染管线，个人项目养不起。记录即可。

### 3.8 设置

**Orca**：34 pane + **68 个搜索索引文件**（每个设置项注册进全局搜索）;实验特性"毕业"机制（从 Experimental 迁到正式菜单 + 旧字段静默迁移 + 搜索条目去重）;表单房屋风格成文。

**CC-Panes**：13–14 个 Section（按平台）组织健康（最大 608 行），但不可搜索。

**定性**：真差距 → P1-2（挂进现有 CommandPalette，一次建注册机制）。

### 3.9 看板 / Issue 集成

**Orca**：GitHub/Linear/Jira/GitLab 四家全接;TaskPage.tsx 536KB（全仓最大文件，issue→task→worktree 中枢）;看板泳道拖拽/框选/从泳道建 worktree。

**CC-Panes**：无外部 issue 集成;Todo 管理器（标签/子任务/过滤）+ Spec 绑定是内生对位物。

**定性**：不在战场（43 号文档已定），记录。我们的任务源是 plan/todo/spec 自循环,不是外部 issue 流。

### 3.10 引导体系

**Orca**：三层——正式 onboarding（40 文件分步流）/ 情境导览（箭头浮层+就绪门控+outcome 追踪）/ 功能提示;另有 feature-wall（81 文件）：每个特性配**纯 CSS/SVG 演示动画**代替静态截图 + 集成连接清单 + 完成度持久化;Landing 预检横幅（缺 ripgrep 等环境问题前置暴露）。

**CC-Panes**：OnboardingGuide 单薄 + Home 新用户引导态。

**定性**：真差距但收益后置（个人项目用户少）——P2。Landing 预检（环境问题前置暴露）是其中最实用的一件,与我们 SystemProbeInfo 已有探测能力可接。

### 3.11 窗口 chrome / 桌宠 / 用量

- 窗口:双方各有完整自定义 titlebar;他们多 Dashboard 弹出窗、worktree 历史前进后退;我们多**无边框模式 + 迷你模式**（反超）
- **桌宠打平**（双方都有!他们 pet/ 状态段,我们 ccchan 独立窗口精灵+漫游+状态感知表情+ChatPanel——形态我们更完整）
- 用量:他们状态栏常驻 8 家 + 账号切换;我们 Home 面板 — 见 3.6

### 3.12 我方独有界面清单（Orca 均无）

Local History 时光机（跨 worktree 版本+标签+恢复）、Provider/多 CLI 管理中心（预设+系统探测+LaunchProfiles）、记忆管理界面、迷你模式、无边框模式、layoutbar 多布局管理（可拖拽布局行+跨布局移动 tab）、SelfChat、RecentFilesPicker(Ctrl+E)、多 agent 编排控制台（全屏视图+leader/worker 任务树+通知聚合）、Journal/Plans/SessionCleaner 运维面板、会话绑定可视化（Link2+SessionBindDialog）、移动原型+Docker 浏览器形态（同一份 web/ 复用）、桌宠（形态更完整）。

## 4. 可移植模式清单

| 模式 | Orca 做法 | 移植成本 | 红线 | 改进项 |
|---|---|---|---|---|
| 风格宪法 | STYLEGUIDE.md 决策表化 + PR 回引 | 低（纯文档） | 无 | P0-2 |
| 共享 spinner 时钟 | 单 setInterval 步进**长期存活的 agent 状态 spinner**（每无限 CSS 动画 ~23.5ms CPU/s 实测;Orca 自己也仍有 383 处普通 animate-spin——短时 loading 不在此列） | 低-中（我方 43 处 animate-spin/29 文件，只迁移长活跃状态类） | 终端内部不碰 | P0-5（rev.2 重定范围） |
| 琥珀=需注意 | 同一琥珀贯穿 tab/卡片/托盘到位图层 | 低 | 无 | P0-2 定约定、P1-3 落地 |
| 主题切换瞬时禁 transition | `.theme-transition-disabled` | 极低 | 无 | P1-4 |
| in-flight 四级分档 | 0-100ms 无/100ms-1s 禁用/1-3s spinner/3s+ 阶段标签 + 预留足迹 + SSH 延迟 200ms 再显 | 低 | 无 | P0-2 成文、P1-4 落地 |
| 设置可搜索 | 68 索引文件注册进全局搜索 | 中 | 无 | P1-2 |
| 行数棘轮 | CI 只减不增 | 低（**vitest 实现**,项目无 ESLint） | 无 | P1-1 |
| i18n AST 护栏 | 禁顶层 translate/伪本地化/JSX 间距守卫 | 中（先做键对等+禁裸文案两道） | 无 | P1-1 |
| BEL 通知合并 | 延迟 BEL 让完成通知胜出,每 burst 一条 | 低 | 无 | P1-5 |
| 状态泳道让位 | 单泳道按优先级切换语义 | 低 | 无 | P1-3 |
| CacheTimer | prompt-cache TTL 倒计时,多 tab 取最紧急 | 中 | 无 | P2 |
| AI Diff 批注闭环 | 行内批注→聚合→Send 给 agent | 高 | 无 | P2 单独立项 |
| hidden delivery gate | 隐藏 PTY 主进程停投字节 | 高（需 Rust） | **terminal-transport-adjacent**：改变 PTY 投递/缓冲/恢复/重连契约，评估须覆盖 core terminal service、Tauri/HTTP 事件边界、前端恢复与 scrollback 补投，并验证隐藏期零丢字节、恢复无重复 | P2 仅评估 |
| parked terminal / hidden-output-restore | 卸载 xterm DOM 保留字节 watcher | — | **撞 TerminalView 红线,不做** | — |

## 5. 我们反超、守住勿退

双语逐文件行数与键路径完全一致（**小范围双语一致性优势**——规模与护栏纵深仍不及 Orca 五语言+三道 AST 护栏，P1-1 落地后方可谈工程反超。**但质量维度已有实机反超实证**：2026-07-24 用户实机运行 Orca，其中文界面出现"2名儿童"级机翻——"2 children" worktree——五语言广度背后 zh 是机翻质量；我们"窄而精"对中文用户是碾压级体验优势）、designTokens.test 组件调色板类守卫先手（准确称谓：它只拦 Tailwind 调色板类，不拦 hex/任意值——见 P1-1 补强）、动效 token 体系、TabBar 交互覆盖面、CurrentActivityBadge 工具级粒度、13 项独有界面（尤其 Local History/Provider 中心/编排控制台——他们的产品形态里做不出这三样）、测试:生产 1.5:1。

## 6. 改进实施计划（自包含，逐项含文件/依赖/验收；rev.2 按评审修订）

排序论证：宪法+护栏最优先（唯一能约束 AI worker 产出质量的东西）;spinner 时钟对多 agent 面板是结构性收益;~~浅色滚动条修复~~已被证实修复（index.css:459 已覆盖亮色含 xterm v5/v6 DOM slider——初稿基于过期的 docs/29 记录，评审纠错），降级为一次 Windows 实机回归确认。

### P0

| # | 项 | 涉及文件 | 依赖 | 预估 | 验收 |
|---|---|---|---|---|---|
| P0-1 | 本对比文档 ✅（rev.2 已吸收评审） | docs/45 | — | 完成 | 评审 13 条全吸收 |
| P0-2 | 风格宪法 ✅（rev.2 同步修订中） | docs/46-frontend-styleguide.md、CLAUDE.md 回引 ✅ | — | 完成 | 决策表可判定组件对错;当前态/目标态分离标注 |
| P0-3（改） | Windows 宿主实机回归确认浅色滚动条（原修复项已过期作废） | 无代码;`npm run tauri:dev` 亮色主题目验+截图 | — | 0.25d | 亮色下终端滚动条滑块可辨,留截图 |
| ~~P0-4~~（作废） | ~~侧栏折叠可发现性（docs/33 欠账）~~ **2026-07-24 复核作废**：ActivityBar 图标条在侧栏收起时常驻可见,点任意视图图标即恢复侧栏（`ActivityBar.tsx` toggleView）——找回入口一直存在,docs/33 欠账记录已过期,不实施 | — | — | — | — |
| ~~P0-5~~（作废） | **2026-07-24 复核作废**：全仓 44 处 animate-spin 逐一归类后全部为短时 loading（刷新按钮/对话框操作/面板首载），本条设想的"长活跃会话状态 spinner"在我方代码库不存在（CurrentActivityBadge/编排卡片/会话行均无旋转动画,会话状态走状态色+徽章）——前提系照 Orca UI 形态误植。预防性约定已入 docs/46（未来引入长活跃旋转必须共享单一动画源）。原文留档：共享 spinner 时钟——**仅长期存活的 agent/会话状态 spinner**（CurrentActivityBadge、编排卡片、会话行等持续旋转类;全仓 43 处 animate-spin 中的长活跃子集,普通短时 loading 保留 CSS spinner 不迁移） | 新 web/hooks/useSpinnerClock.ts + web/components/ui/Spinner.tsx（新建,目标态组件）+ 长活跃使用点迁移 | — | 1-1.5d | 长活跃 spinner 单动画源;8 会话卡 DevTools Performance 动画 CPU 对比下降;vitest 护栏:**新增长活跃场景**禁用裸 animate-spin（白名单存量） |

### P1

| # | 项 | 涉及文件 | 依赖 | 预估 | 验收 |
|---|---|---|---|---|---|
| P1-1 | 机器护栏套件（vitest 版,项目无 ESLint）:①行数棘轮（快照 usePanesStore/TerminalView/LaunchProfilesPanel 现值只降不升,新文件≤500）②i18n 键对等（en/zh-CN 15 ns 键集合全等）③禁裸文案（白名单）④**hex/任意值色守卫**（补 designTokens.test 只拦调色板类的缺口,含亮暗 token 对等） | web/test/{lineRatchet,i18nParity,noRawText,colorGuard}.test.ts | — | 2d | 四测试进 npm run test:run;向巨石加 10 行会红 |
| P1-2 | 设置可搜索:13-14 Section 设置项索引（id+i18n 键+锚点）注册进现有 CommandPalette,跳转+高亮;**数字从 sections 数组生成防漂移** | web/components/settings/settingsSearchIndex.ts（新）、CommandPalette.tsx、SettingsPanel.tsx、i18n | — | 2-3d | 面板搜"字体/通知/快捷键"直达高亮 |
| P1-3 | 状态可视化统一+会话行增密:①**拆两个组件**——`ui/SessionStatusIndicator`（终端生命周期,按真实 TerminalStatusType 联合类型**穷举**映射:initializing/thinking/toolRunning/compacting→时钟 spinner;waitingInput→琥珀;idle→**中性灰**;exited→灰;error→红;legacy active 按现语义）与 `ui/TaskStatusIndicator`（任务结果:completed→success 绿,failed→红）——**终端 idle 不用 success 绿**（评审高危纠错:勿混生命周期与任务结果）②SessionsView 会话行增密（CLI 图标/分支/相对时间）③琥珀未读约定落地（tab/卡片/托盘同 token） | 两个新 ui 组件、SessionsView、TabBar、CurrentActivityBadge、OrchestratorTaskCard | P0-2、P0-5 | 2-3d | 全应用状态表达仅此二组件;映射表与 docs/46 一致;类型层穷举(switch 无 default) |
| P1-4 | in-flight 分级落地（useDelayedPending:100ms 延迟显 pending、3s+ 阶段文案,套启动会话/git clone/扫描导入等 3-5 处）+ 主题切换瞬时禁 transition | 新 hook、LauncherDialog、GitCloneDialog、ScanImportDialog、index.css + 主题切换处 | P0-2 | 1-2d | 快操作无闪烁;慢操作有阶段文案;切主题无渐变残影 |
| P1-5 | 通知合并:BEL 与完成事件短窗口合并每 burst 一条（仿 Orca 延迟 BEL） | 通知派发 service/hook（实施者定位 web/services/ 通知路径） | — | 1d | 单测模拟竞态,一次完成仅一条通知 |
| P1-6 | **右侧停靠面板位面 + 会话历史面板 + 左侧 ActivityBar 瘦身**（2026-07-24 用户实机体验 Orca 后拍板,连发三次确认）。**信息架构原则（用户拍板）**:**左侧 = 导航**（工作空间树/项目/文件浏览）,**右侧 = 工具面板**——现有 ActivityBar 上的工具类入口（SSH 机器、编排、记忆、待办）**迁出左栏**,成为 RightDock 住户;左栏图标条只留导航类,红点/徽章语义随面板走。**灵活性是差异化**:不学 Orca 写死 7 tab——做**可停靠面板宿主**（RightDock）:窄图标条 + 内容区,宽度可拖拽持久化,可折叠;**面板停靠位置可配置**（每个面板可选:右坞常驻 / Dialog 弹出,记住用户偏好——"好好配置"的具体含义）;现有 Dialog 面板复用现组件、双形态。**迁移期兼容**:左栏旧入口保留一个版本周期,点击跳转右坞对应面板并提示新位置,防肌肉记忆断裂。**模块化架构（2026-07-24 用户追加拍板:"ccpane 需要模块化"）**:所有工具面板收敛为**模块注册表**——每个模块一条声明 `{id, 图标, 标题, 支持的停靠位(左栏/右坞/Dialog/隐藏), 默认位, 徽章数据源, 首次启用引导卡}`;**用户可选**:设置页"模块"区 + 图标条右键勾选（Orca 状态栏右键勾选段的先例）控制启用/停靠位,偏好持久化;**新模块默认关闭**,启用时弹双栏引导卡（左说明+右演示,联动 P2 引导体系——"清晰指引"的落点）;实验性模块走"毕业"流程（Experimental 区→正式区+旧配置静默迁移,Orca 先例）。模块注册表同时是 CommandPalette 动作源与未来画布能力节点的枚举源——一表三吃。首批模块清单:SSH 机器、编排、记忆、待办、会话历史(新)、Local History、Git 时间线、Journal、Plans、SessionCleaner、ccchan。**首个新住户 = 会话历史面板**（规格按实机截图逆向）:每行 = 会话标题 + **末条 agent 消息摘要** + 消息数 + 子 agent 数 + 相对时间 + 模型徽章 + 项目徽章;**工作区/项目/全部三档 scope + 搜索**;点击行 → resume（走现有 launch_task resumeId）。数据源映射:标题/时间←launch history;摘要/消息数/子 agent 数←`~/.claude/projects` jsonl 转录解析;模型←转录 meta;Codex 会话←rollout 目录（注意 docs/45-codex-resume 捕获链兜底）。**整个对比里投入产出比最高的单项——强化自有 resume 差异化资产而非补课** | 新 web/components/rightdock/（宿主+会话历史面板）、AppShell 布局、会话转录解析 service（或复用 list_claude_sessions/list_resume_sessions MCP 后端加摘要字段）、i18n | P0-2 | 3-4d |
| P1-7 | **pane 标题栏命令入口**（用户点名）:终端 pane 顶部动作簇加"命令"按钮——常用命令/快捷动作菜单（对位 Orca pane-title actions:续接会话/切视图/Split 簇）,与现有 TabBar 右键能力去重(入口提级不是功能新增) | panes/Panel.tsx 标题栏、快捷动作定义复用 CommandPalette 的 action 注册 | — | 0.5-1d |
| P1-8 | **"+"搜索式创建菜单**（用户实机点名,对位 Orca TabBarCreateEntry）:TabBar 的 + 从"直接新建终端"升级为下拉菜单——顶部搜索框（"打开任何文件、URL、智能体…",模糊匹配菜单项/输路径直接开文件/输 URL 留给浏览器 tab 落地后接）+ 分区:新终端按 Windows shell 分裂（PowerShell/cmd/git bash,复用现有 shell 检测）、新 Markdown（EditorView 已有）+ **快速启动 agent 列表**（cc-cli-adapters 已注册的 8 家:Claude/Codex/Grok/OpenCode/Kimi/GLM/Cursor/Gemini,带各家图标,点击=当前项目 launch_task）+ 底部"运行配置…"入口。关闭菜单焦点交给新建终端（Orca 细节） | panes/TabBar.tsx 的 + 按钮、新 TabCreateMenu 组件（cmdk 复用）、CLI 注册表读取、i18n | — | 1-2d |

### P2（择机）与不做清单

P2:**浏览器 tab 类型**（用户点名"我也想要"）——先做 0.5d 技术评估 spike 再定实现:Orca 是 Electron `<webview>` 一行嵌入,**Tauri 2 没有等价物**——候选路径 ①multiwebview(一窗多 webview,官方 unstable feature,需验证 Windows WebView2 下与 xterm 布局共存/输入焦点/DPI)②卫星 WebviewWindow(独立窗口伪装成 tab,tab 激活=窗口前置贴附——实现稳但体验折衷)③iframe(受 X-Frame-Options/CSP 限制,只适合自家 dev server 预览——**恰好覆盖最高频场景**:agent 起的 localhost 预览)。建议 spike 先验 ③+①,按"dev server 预览优先、通用浏览次之"取舍;评估结论回写本节再排期实现(2-3d);**快捷命令库**（用户确认收录,优先级放低）——标签 + 类型（终端命令→复用 RunnerProfiles 深度能力或直发当前终端 / 智能体提示→绑定 agent,submit_to_session 或 launch_task,提示内容支持引用 skill 与文件路径）+ 作用域,CRUD 一个小 Dialog（0.5-1d 增量）;**不单独做入口**——作为 CommandPalette、P1-7 pane 命令菜单、P1-8 "+"菜单的共享数据源（该两项实施时菜单数据源预留"用户快捷命令"接口,后接零改动）;**引导体系升级**（用户实机体验后点名"真不错"）——feature-wall 式**双栏引导弹框**（左侧文案+行动按钮、右侧动态演示区,演示用纯 CSS/SVG 动画不用截图;首批场景:MCP/skill 安装引导、worktree 隔离模式介绍、会话历史面板发现;弹框双栏模式同时进 docs/46 §1 作为"大型引导/功能介绍弹框"的标准形态）+ Landing 环境预检横幅（复用 SystemProbeInfo 探测能力,缺 CLI/WSL 问题前置暴露——**对照 Orca 实机在 Windows 上 cli:install 超时报错的反例:引导流程第一步失败必须给可读的修复指引而非 toast 报错**）;git 审查区升级（最大差距面,单独立项;交互流规格已在 §3.4 记全）、扩展**现有 StatusBar**（provider 用量段+账号切换,勿新建位面）、CacheTimer、双击修饰键、长列表虚拟化（排除 TerminalView）、hidden delivery gate 评估（terminal-transport-adjacent,评估范围见 §4 表）、跨平台+无障碍决策表扩充（docs/46 §9 已补基础版）。
不做:parked terminal / hidden-output-restore（撞 TerminalView 红线）、native-chat、看板/issue 四家集成、token 推倒重来。

**通用约束**:每项独立可派工（plantocodex/plantocc,可用 worktree 隔离模式）;WSL worker 测试全绿≠Windows 通过,**合并后 Windows 宿主补跑一轮**;新增色值过色守卫;文档类改动交叉评审。
