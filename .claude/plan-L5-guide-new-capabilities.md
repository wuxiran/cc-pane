# L5 · 补写 4 篇 guide：新能力的教程落点

> 属于 docs/67 发现性计划。**本 plan 由两个 worker 分头执行，各写两篇。**
>
> 注意：这一步**推翻了 docs/67 §6「不写新教程」**。推翻的理由见下，
> 是用户拍板后的决定，不要再按 §6 的原话行事。

## 为什么要破例

docs/67 §0 的核心论断是「不缺内容缺路径——`docs/guide/` 19 篇覆盖完好，
要建的是通往教程的路」。leader 核实后发现这只对一半：

| 能力 | guide 落点 |
|---|---|
| 派工编排 | ✅ `12-leader-worker.md` |
| worktree 隔离 | ✅ `07-git-worktree.md` |
| **AI 面板** | ❌ 全 guide 零提及 |
| **右坞** | ❌「右坞」一词零出现 |
| **浏览器 tab** | ❌ 4 篇提到「浏览器」但全指外部浏览器访问 Web 端，无一处讲应用内 tab |
| **skill 体系** | ⚠️ 4 篇顺带提及（01 / 10 / mcp-orchestration / appendix-a），无专篇 |

即：guide 覆盖完好的是**上一代能力**；docs/58 点名「用户永远不会知道存在」
的那批新能力，教程里同样不存在。对它们是**路和终点都缺**。

所以补这 4 篇，tips 扩容（L2）才有落点可指。

## 分工

| worker | 篇目 | 线 |
|---|---|---|
| **L5a** | AI 面板、skill 体系 | 编排线（内容深，价值最高） |
| **L5b** | 右坞、浏览器 tab | 日常线 |

两个 worker 文件集不相交，可并行。

### 编号与文件名

`docs/guide/` 现有编号：01–05（入门）、06–10（日常使用）、
11–16 + `mcp-orchestration.md`（高级玩法）、`appendix-a/b/c`（参考）。

- L5a 的两篇归**高级玩法**层，用 `17-` / `18-` 续号。
- L5b 的两篇归**日常使用**层。该层现有 06–10 已满，
  **不要插队重排既有编号**（会打断所有既有交叉引用）。改用 `19-` / `20-` 续号，
  在索引里归入「二、日常使用」分组即可——编号是文件名，分组是索引里的事，两者不必一致。

具体文件名由你定，但必须与既有风格一致（`NN-kebab-case.md`）。
在上报里说明你用了哪个编号，leader 要据此更新索引。

> 编号风格提示：既有文件里 01–05 用 `# 1.` 无前导零，06–16 用 `# 06.` 有前导零。
> 你的新篇统一用**有前导零**（跟随较新的一批）。

---

## 硬约束（两个 worker 都适用）

### 1. 内容必须来自代码，不能编

这是**用户手册**，写错了比不写更糟——与 docs/58 §1.1「教错快捷键比不教更糟」
同理。每一个你写进教程的操作路径、按钮名、快捷键、默认值，
都必须回代码或既有 docs 核实过。

- 快捷键：必须查 `cc-panes-core/src/models/settings.rs` 的
  `impl Default for ShortcutSettings` 拿真实默认值，不要凭印象写。
- **特别注意**：`useShortcutsStore.ts:16-24` 有个 `TERMINAL_PASSTHROUGH_ACTIONS`
  清单，其中的快捷键在**终端聚焦时会被放行给终端、不生效**。
  若你要写的快捷键在这个清单里，必须写明这个限制。
- UI 文案：查 `web/i18n/locales/zh-CN/` 下的真实 key，不要自己造中文按钮名。

**核实不了的内容宁可不写**，并在上报里列出你放弃了哪些点及原因。

### 2. 体例对齐既有 guide

先完整读 2–3 篇既有 guide（建议 `07-git-worktree.md`、`12-leader-worker.md`、
`16-web-and-mobile.md`）再动笔。要对齐的：

- 开头一句 `>` 引言，讲**这个功能解决什么问题**，不是「这是什么」
- 「什么时候用得上」式的场景列表
- 操作步骤用有序列表，配真实的界面位置描述
- 结尾常见问题 / 排障
- 语气：第二人称、口语、短句。参照 16 篇里
  「你躺在沙发上也能看 Claude 跑到哪了、卡住了就在手机上敲两下继续」这种写法。

### 3. 配图

`docs/guide/README.md` 第 10 行有免责声明：
「手册中的界面配图为按**当前版本 UI 结构**绘制的示意图」。

**本轮不要新增配图。** 主页素材正在并行录制（docs/67 §3），
两边的素材策略还没定完，现在加图会返工。写文字，在需要图的位置留一行
HTML 注释占位 `<!-- TODO(img): 描述这里需要什么图 -->`，leader 会统一收口。

### 4. 不要改索引

`docs/guide/README.md` 是两个 worker 的共同冲突点。
**谁都不要改它**，leader 统一更新。你只需在上报里说明：
文件名、标题、应归入哪一层、一句话简介。

### 5. 不要提交 git

---

## 各篇的内容起点

以下只是起点提示，实际内容以你读代码后的判断为准。

### L5a-1 · AI 面板

0.11.3 交付，`docs/64-ai-panel-templates.md` 是方向文档（**注意 64 标注「未排期」，
里面有未实现的构想，不要把没做的功能写进用户手册**）。

代码起点：`web/components/aipanel/`、MCP 工具 `open_ai_panel` /
`update_ai_panel` / `close_ai_panel` / `get_ai_panel_events`、
`AiPanelRepository`、按工作空间的面板历史与认领（见 git log `d2bd49d`）。

要讲清楚：它是什么、和终端标签有什么区别、AI 怎么经 MCP 往里投递内容、
用户在界面上怎么打开和看历史。

### L5a-2 · skill 体系

代码起点：MCP 工具 `list_skills` / `list_external_skills`、
`skillService.listUserSkills()`（`SetupGuideChecklist.tsx:103-117` 有调用示例）、
`.claude/` 下的 skill 源目录结构、`docs/65-skill-observation-contract.md`。

要讲清楚：skill 是什么、CC-Panes 内置了哪些、用户怎么调用、
项目级 vs 用户级的区别、怎么自己加一个。

注意区分「Claude Code 的 skill 机制」与「CC-Panes 提供的 skill 集合」——
用户视角要能分清哪些是 CC-Panes 给的。

### L5b-1 · 右坞

代码起点：`web/components/rightdock/RightDock.tsx` 及同目录。
相关 action：`show-explorer` / `show-sessions` / `show-files`
（注册于 `useShortcutRegistrations.ts:192-206`）。

**已知坑，必须在教程里如实写**：这三个 action **没有默认快捷键**，
且因为 `settings.rs` 默认 bindings 里没有条目，
它们在「设置 → 快捷键」页面里**完全不可见、无法绑定**——只能从命令面板触发。
不要写「你可以在设置里给它绑个快捷键」，那是做不到的。

要讲清楚：右坞是什么、有哪几个视图、怎么打开、和左侧栏什么关系。

### L5b-2 · 浏览器 tab

代码起点：MCP 工具 `open_browser_tab` / `browser_navigate` / `browser_click` /
`browser_evaluate` / `browser_screenshot`。前端搜 browser tab 相关组件。

**注意消歧**：guide 现有 4 篇提到「浏览器」全是指**外部浏览器访问 Web 端**
（`16-web-and-mobile.md`）。你写的是**应用内的浏览器标签页**，是另一回事。
开篇就要把这个区别点破，否则用户会和 16 篇混淆。

要讲清楚：怎么开、能干什么、AI 能不能操作它（MCP 工具说明它可以）、
典型用法（比如开着文档边看边写、让 AI 截图页面）。

---

## 验收

- 4 篇文件已创建，编号与既有风格一致
- 每篇都有引言、场景、操作步骤、排障
- 所有快捷键、按钮名、默认值都回代码核实过
- 在放行清单里的快捷键已写明终端聚焦时的限制
- 需要配图处留了 `<!-- TODO(img): ... -->` 占位，未新增图片文件
- **没有改 `docs/guide/README.md`**
- 没有把 docs/64 里未实现的构想写进手册

## 收尾

按 docs/65 观测契约上报。必须包含：
写了哪几个文件（文件名 + 标题 + 应归入哪一层 + 一句话简介，leader 要拿这个更新索引）、
哪些内容你核实不了因而放弃了、
你在读代码时发现的与本 plan 描述不符的地方。
