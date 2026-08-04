# L2 · tips 扩容：补 6 条，覆盖最贵的能力

> 属于 [docs/67](../docs/67-discoverability-plan.md) §4。
> **前置：L0（快捷键真值修复）必须已合入**——它改了同一批文件，
> 且它加的「终端放行限制说明」机制是本轮要复用的。

## 背景：为什么补这 6 条

`featureTipRegistry.tsx` 当前只注册 **4 条**，全是 UI 操作技巧
（command-palette / layout-switcher / mini-mode / unified-launcher）。

docs/58 §2.1 点名「用户永远不会知道它们存在」的那批能力——
派工编排、worktree 隔离、skill 体系、AI 面板、右坞、浏览器 tab——
**一条都没覆盖**。最贵的编排能力零覆盖。

## 落点已全部就位

这是本轮能开工的前提。六条的 guide 落点：

| tip | 落点 | 状态 |
|---|---|---|
| 派工编排 | `docs/guide/12-leader-worker.md` | 既有 |
| worktree 隔离 | `docs/guide/07-git-worktree.md` | 既有 |
| AI 面板 | `docs/guide/17-ai-panel.md` | **本轮新补** |
| skill 体系 | `docs/guide/18-skills.md` | **本轮新补** |
| 右坞 | `docs/guide/19-right-dock.md` | **本轮新补** |
| 浏览器 tab | `docs/guide/20-browser-tab.md` | **本轮新补** |

**动手前先把这 6 篇读一遍**。tip 的文案必须与落点教程说的是同一件事，
否则用户点进去发现讲的不是刚才看到的东西。

---

## 任务 1 · 先改结构（内容之前）

### 1.1 `FeatureTipDefinition` 没有落点链接字段

`featureTipRegistry.tsx:14-24` 的定义里**没有任何文档链接字段**。
要实现「tip → guide」必须先扩字段，再在 `FeatureTip.tsx` 加渲染位。

设计要求：
- 字段可选（既有 4 条不强制加，但**建议顺手补上**，见任务 3）
- 渲染成一个「了解更多」性质的链接，位置在左栏文字区，不要挤主行动按钮
- **链接怎么打开是个真问题**：这是 Tauri 桌面应用，`docs/guide/*.md` 是仓库内文件。
  先去查清楚本仓库既有的「打开文档」惯例是什么——
  是用内置 Markdown 预览打开本地文件，还是开外部浏览器指向 GitHub？
  **按既有惯例做，不要自创第三种**。查不到惯例就在上报里说明并给出你的选择与理由。

### 1.2 `shortcutTip()` 辅助套不了这 6 条

`featureTipRegistry.tsx:137-145` 的 `shortcutTip()` 自动补 `tryAction`（跑该 action）
与 `eligible`（该 action 已注册）——它隐含假设「一条 tip = 一个快捷键 action」，
当前 4 条全走它。

**本轮 6 条多数没有对应的 shortcuts action**，必须手写 `tryAction` / `eligible`。
逐条想清楚：
- `tryAction`：点「试试看」之后**具体发生什么**？docs/58 §1.1 立的原则是
  「tip 的价值在于用户真的用一次」——不要写成空函数或只是打开设置页。
- `eligible`：什么情况下这条 tip 不该出现？
  （例：没有任何项目时不该推「派工编排」；非 Windows 时浏览器的截图能力不可用）

---

## 任务 2 · 六条 tip

演示设计要点见 [docs/67-storyboards.md](../docs/67-storyboards.md) §2 的
「tips 演示」小节，逐条已写。本 plan 只补该文没写的约束。

### 通用视觉约束（docs/46 §6.1，硬约束）

- **只用 CSS / HTML / 内联 SVG**。禁止产品截图、位图、任何需要网络加载的素材。
  主页正在录的 GIF **不能拿来用**——两边共享的是分镜脚本，不是文件。
- 套 `VisualStage`（`featureTipRegistry.tsx:34-40`）
- 颜色走 `var(--app-*)` token，暗/亮色自动适配
- 文字用骨架条（`h-1.5 w-24 rounded-full bg-[var(--app-hover)]`）代替真实文案，天然免 i18n
- **动画必须用现有 `var(--dur*)` token**。
  ⚠️ 现有 `MiniModeVisual`（`:104`）用的是 Tailwind `animate-pulse`，
  **这是既存偏差，不要复制**（docs/68 已记为待修条目）。
  参考正确写法：`SetupGuideChecklist.tsx:155`、`ShortcutsSection.tsx:102`
- `prefers-reduced-motion` 下停用位移与循环，直接呈现终态
- 右栏对读屏 `aria-hidden`，**所有信息必须同时在左栏文字里可获得**

### 逐条的特殊约束

**① 派工编排** → `12-leader-worker.md`
三个 worker 的状态点用**不同 delay**，reduced-motion 下直接呈现终态（一蓝两绿）。
不要让三个同步跃迁——整齐划一丢掉了「盯着它们跑」的意味。

**② worktree 隔离** → `07-git-worktree.md`
主节点 + 两个缩进子节点，主节点旁绿色 ✓（clean），子节点旁蓝点（有改动）。
静态即可。论点是**别动我主树**。

**③ AI 面板** → `17-ai-panel.md`
终端矩形 + 面板矩形 + 中间箭头，面板内骨架条按 delay 依次淡入。
⚠️ `docs/64` 里的面板模板化与 fleet 拓扑**代码里都不存在**（只有 `content: String`），
文案不要暗示这些。

**④ skill 体系** → `18-skills.md`
输入框 + 下方 5 条列表项，第 2 条高亮。静态。
⚠️ 已核实的事实：磁盘上发布 **24 个**内置 skill，但运行配置 UI 的勾选清单**只列 4 个**
（`core_skill_ids()`）。文案要指向 `/` 的完整列表，不要指向那个只有 4 项的设置页。

**⑤ 右坞** → `19-right-dock.md`
主区域 + 右侧推入的窄栏，栏内两个 tab 切换态。
⚠️ **不要画快捷键 chip**：`show-explorer` / `show-sessions` / `show-files`
三个 action 没有默认快捷键，且在「设置→快捷键」页面不可见、无法绑定，
只能从命令面板触发。画了 chip 就是教错。
⚠️ 更麻烦的一层：命令面板本身走 `Ctrl+K`，而 `Ctrl+K` **在放行清单里**——
终端聚焦时它也不生效。所以「只能从命令面板触发」这条唯一路径在默认状态下同样是断的。
`tryAction` 要能真的把右坞打开（直接调 store，不要依赖快捷键分发）。

**⑥ 浏览器 tab** → `20-browser-tab.md`
带地址栏的矩形 + agent 图标，箭头**从 agent 指向页面**（方向反了就变成「你去开」）。
⚠️ 已核实：**用户没有任何 UI 入口**——全仓库唯一的 `openBrowser()` 调用点是
`useOrchestratorListener.ts:283`（监听 MCP 事件）。所以：
- 文案不能写「打开一个浏览器标签」，那是用户做不到的事
- `tryAction` 要么真能开一个（若你找到可行的程序化入口），
  要么这条 tip **没有可执行的主行动**——若是后者，在上报里说明，
  不要写一个点了没反应的按钮（那正是 docs/58 §1.1 骂的「按一次没反应就再也不信」）
⚠️ `browser_evaluate` / `browser_screenshot` / `browser_click` **只在 Windows 可用**
（`browser_service.rs:529-536` 非 Windows 直接返回错误）。`eligible` 要考虑平台。

---

## 任务 3 · 顺手补既有 4 条的落点（可选但建议）

既有 4 条也没有落点链接。对应关系：
- `command-palette` / `layout-switcher` / `unified-launcher` → `05-terminal-and-panes.md` 或 `10-settings.md`
- `mini-mode` → 查一下 guide 里哪篇讲了迷你模式，没有就不加

**先核实再加，不要瞎指**。加不上的在上报里说明。

---

## 任务 4 · 权重与节奏

`weight` 字段控制加权随机（默认 1）。现有：command-palette 3、layout-switcher 2、
mini-mode 1、unified-launcher 2。

扩到 10 条后，**最贵的能力应该更容易冒出来**。建议派工编排与 worktree 隔离给较高权重，
但你自己判断——理由写进上报。

⚠️ 顺带留意一个既有缺陷（**本轮不修，docs/68 已排期**）：
`selectFeatureTip` 的候选过滤只看 `seen`，全部展示完后 `candidates.length === 0` → 
`return null`，**tips 永久沉默**。扩到 10 条只是把沉默推迟，没有解决。不要在本轮顺手改它。

---

## 硬约束

- **双语**：`web/i18n/locales/en/settings.json` 与 `zh-CN/settings.json` 必须同批加，
  namespace 是 `settings`，key 路径一致。这是 docs/46 §7 的硬约束。
- **快捷键真值**（docs/58 §1.1）：任何展示的键位必须从
  `settings.shortcuts.bindings[actionId]` 实时读 + `formatKeyCombo()`，
  未绑定则隐藏 chip。**不要硬编码键位字符串**。
- L0 已实现「终端放行清单派生的限制说明」机制，**复用它，不要另造**。

## 验收

```
npx tsc --noEmit
npm run test:run
```

**禁止用 `| tail`**——本仓库明确记录管道会掩码退出码（取自 tail，永远成功），
把失败报成通过。判定看真实退出码。
vitest 若报 fork 超时类 Errors，用 `--maxWorkers=3` 重跑再判（已知高负载假失败）。

### 测试要求

`web/components/tips/` 下已有测试文件。至少覆盖：
- 落点链接字段有值时渲染、无值时不渲染
- 6 条新 tip 的 `eligible` 各自的真/假分支
- 有 `tryAction` 的条目点击后确实调用了对应 store/service
- 平台相关的 `eligible`（浏览器 tab）在非 Windows 下返回 false

### 自查

- [ ] 演示零位图、零网络素材
- [ ] 动画走 `var(--dur*)`，没有新的 `animate-pulse`
- [ ] reduced-motion 下有终态呈现
- [ ] 右坞那条没有快捷键 chip
- [ ] 浏览器 tab 的箭头方向是 agent → 页面
- [ ] 没有点了没反应的「试试看」按钮
- [ ] en / zh-CN 两份 key 齐平
- [ ] 右栏 `aria-hidden`，信息在左栏可获得

## 边界

- 不要改 `TERMINAL_PASSTHROUGH_ACTIONS`
- 不要修 `selectFeatureTip` 的永久沉默问题（docs/68 已排期）
- 不要碰打扰闸门 `interruptGate.ts`
- 不要动 `docs/`、`README*`、`CLAUDE.md`
- 不要提交 git

> ⚠️ **跨计划冲突提醒**：docs/68 §5.2 也要改 `featureTipRegistry.tsx`。
> 本轮先做先合，68 那条要在本轮合入后再排。

## 收尾

按 docs/65 观测契约上报。必须包含：
6 条各自的 `tryAction` / `eligible` 实现方式与理由、
落点链接的打开方式（用了哪个既有惯例）、
两条命令的真实退出码、新增测试数、
以及浏览器 tab 那条最终有没有可执行的主行动。
