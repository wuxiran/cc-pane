# L3 · 编写 docs/68：交互体验计划

> 本 plan 的产出是**一份计划文档**，不是代码改动。
>
> 背景：docs/67 把「完善人机交互」理解为**发现性**（主页 + tips），
> 用户确认范围是「全部都要」——发现性按 67 推进，
> **交互体验本身需要另起一份 docs/68**，就是本 plan 的任务。

## 你要产出什么

`docs/68-interaction-quality-plan.md`（文件名可按仓库 docs/ 的既有风格微调，
但编号必须是 68——已确认 docs/ 下当前最大编号是 67）。

同时在 `CLAUDE.md` 的「文档引用」表格里加一行指向它，格式对齐既有行。

## 定位：它与 67 的分工

- **67 管「用户不知道我们能干什么」**（发现性：主页 + tips）
- **68 管「用户知道了，但用起来别扭」**（交互质量：快捷键体系、操作可逆性、空态一致性）

在 68 开头写清这条分界，并回引 67。两份文档不要内容重叠。

---

## 素材：已核实的问题清单

以下条目来自一次只读代码盘点，**行号均已核实**。你的工作不是重新发现问题，
而是把它们组织成一份可派工的计划：归类、判轻重、定先后、写清每条的验收标准。

**你必须逐条回代码复核**——盘点可能有偏差，写进计划的每条都要你自己确认过。
复核不实的条目直接删掉并说明。

### 已坐实（有行号证据）

**A1 · Ctrl+W 漏杀分屏会话且绕过 dirty 确认**
`Panel.tsx:154-182` 走 pinned 检查 + dirty 确认 + `collectTerminalSessionIds` 全量 kill；
`useShortcutRegistrations.ts:99-114` 只 kill 单个 `tab.sessionId`，三样保护全无，
错误只 `.catch(console.error)`。后果：孤儿 PTY 留在 daemon 里、静默丢未保存编辑。
→ **此条已派给 L0 修复，68 里只作为「已修」记录一句，不要重复排期。**

**A2 · 关闭标签 = 杀进程，运行中的 agent 会话无任何确认**
`Panel.tsx:154-168`（单个）、`:193-218`（「关闭其他/关闭右侧」批量路径，
确认条件同样只看 `t.dirty`）、`LayoutDeleteDialog.tsx:115`（删布局连带杀会话）。
一个跑了 40 分钟的 agent 会话与一个空终端，关闭待遇相同。无 undo、
无「最近关闭的标签」恢复入口。CC-Panes 自述的核心场景是长时无人值守派工。

**A3 · 三个已注册 action 在设置页里根本不存在**
`show-explorer` / `show-sessions` / `show-files` 注册于
`useShortcutRegistrations.ts:192-206`，但 `cc-panes-core/src/models/settings.rs:1053-1079`
的默认 bindings 不含它们，而 `ShortcutsSection.tsx:92` 的渲染源是
`Object.entries(value.bindings)`——未绑定的动作永远不可见、不可绑。
附带问题：这三条 label 是硬编码英文（`:194,199,204`），违反 docs/46 §7 双语硬约束。

**A4 · 快捷键冲突只拒绝，不给出路**
`ShortcutsSection.tsx:70-74` 命中 `findConflict` 即 toast 警告并拒绝写入，
不提供「替换并解绑原动作」。用户完成一次重绑最少需 4 次以上定位，
且 35 条列表无搜索。

**A5 · 快捷键设置页缺恢复默认 / 搜索 / 清除绑定**
`ShortcutsSection.tsx` 全文 118 行，无 reset、无 filter、无解绑。
改坏了不可逆（除非删配置文件）。`switch-tab-1..9` + `switch-layout-1..9`
共 18 条数字项占列表一半。`SearchableSetting sectionId="shortcuts-list"`（`:90`）
把 35 条当**一个**搜索锚点，设置页全局搜索只能带到列表顶部。

**A6 · 终端聚焦时 7 个主快捷键静默失效，UI 无任何体现**
`useShortcutsStore.ts:16-24` `TERMINAL_PASSTHROUGH_ACTIONS`，
放行发生在 `handleKeydown:150-152` 与 `shouldTerminalHandleKey:178-180`。
这是产品的**默认状态**（终端几乎总是聚焦），却在设置页、命令面板里都显示为正常绑定。
→ L0 已在 tips 侧加了限制说明（治标）。**根治方案属于 68**：
是否重新划分放行清单、是否给终端一个「快捷键前缀键」、
或在设置页标注哪些键在终端里不生效。源码注释里逐条写了当初放行的 TUI 冲突理由，
**你必须先读懂那 7 条理由再提方案**，不要无视它们直接建议「移出清单」。

**A7 · 打扰闸门的「有弹窗打开」判定是手工枚举**
`web/lib/interruptGate.ts:71-87` `hasOpenDialog()` 逐个 `||` 列出 12 个 flag，
与 `useDialogStore` 的实际集合靠人工同步。漏一个 → tip/更新卡盖在对话框上。
CLAUDE.md 记录了多起「注册项与消费者不同步」的同类事故。

**A8 · tips 的「用过没用过」判据其实是「有没有给你看过」**
`FeatureTips.tsx:180-191` 只在弹窗出现时写 `seen`/`tried`；
`selectFeatureTip:77` 的候选过滤只看 `seen`。仓库里没有任何「功能被实际使用过」的计数。
后果：天天用 Ctrl+K 的用户仍会被教 Ctrl+K；4 条展示完后 tips 永久沉默
（`candidates.length === 0` → `return null`，无轮换）。
docs/58 §3.3 把「上下文触发」列为优先级 1 且原文写「不要长期缺席」，至今未实现。
→ **注意分工**：tips 的**内容扩容**属于 67/L2；tips 的**触发智能**（用量计数、
上下文触发）属于 68。在文档里划清这条线。

**A9 · 空状态没有统一形态**
`web/components/ui/EmptyState.tsx` 存在（图标 + 标题 + 说明 + 可选 CTA），
但只被 9 个组件文件使用：WorkspaceTree / RecentLaunches / RightDock /
VersionListSidebar / TodoManager / ProvidersPanel / AiPanelHistoryList /
TaskDetailPanel / OrchestrationFullView。
而 `empty|没有|暂无` 在 `web/components/` 下命中 249 处 / 118 个文件。
已抽样确认的手写裸文本空态：`LaunchProfilesPanel.tsx:1136-1137,1578,1973`、
`MobilePrototype.tsx`（8 处）、`FileSearchView.tsx`（2 处）。
空态是新用户遇到最多的界面，有无 CTA 目前是随机的。

**A10 · tip 演示动画没走 duration token**
`featureTipRegistry.tsx:104` 用 Tailwind `motion-safe:animate-pulse`；
docs/46 §6.1 要求「动画必须使用现有 duration/easing token」
（仓库内 token 形如 `var(--dur)`，见 `SetupGuideChecklist.tsx:155`、
`ShortcutsSection.tsx:102`）。reduced-motion 侧是合规的，问题只在时长来源。
扩容到 10 条 tip 会把偏差复制 10 份。

### 需你实测确认（盘点标为推测，未坐实）

**B2 · 重复 combo 导致触发不确定**
`handleKeydown:145-159` 遍历 bindings 取第一个匹配，顺序即 `Object.entries` 顺序；
而 `settings.rs:1376-1387` 的测试明确断言用户自定义 combo 与默认 combo **共存**。
推理上会产生「同一个键，不同启动触发不同动作」。
需构造真实配置验证 serde HashMap 反序列化后的顺序稳定性。**坐实了才写进计划。**

**B3 · `sessionCount` 语义可能与 docs/58 不符**
`FeatureTips.tsx:110-117` 挂载时 +1，靠模块级 `sessionCountRecorded` 去重
（React 19 严格模式 dev 双挂载，见 CLAUDE.md）。但 `persistTips` 失败会复位 flag（`:114`）
并可能重试计数。是否漏计/多计需实测。

**B4 · 首启引导 Esc 即完成**
`OnboardingGuide.tsx:449` 的 `onOpenChange` 在非 busy 时调 `complete()`，
误触 Esc 会把 `onboardingCompleted` 永久置 true。
**但这符合 docs/46 §6.1「关闭、Esc 与跳过全部收敛到同一持久化语义」，
且设置里有重跑入口**——所以这不是缺陷，是需要产品决策的点。
在 68 里如实呈现两面，不要单方面判它是 bug。

---

## 计划文档的写法要求

参照 `docs/67-discoverability-plan.md` 与 `docs/66` 的体例。要求：

1. **先诊断再开方**。每条问题给：现象、代码位置（带行号）、为什么算问题、
   影响面（多少用户会碰到、多久碰到一次）。
2. **判轻重要有依据**。不要平铺 10 条同等重要。建议按
   「不可逆损失 > 教错用户 > 效率损耗 > 一致性瑕疵」的量级排。
   A2（杀 agent 会话无确认）与 A6（教错快捷键）明显重于 A10（动画 token）。
3. **明确不做什么**。参照 67 §6 的写法，写清边界。
4. **可派工**。每条给出可独立交付的粒度与验收标准，让它能像本 plan 一样被直接派出去。
5. **标注依赖**。哪些条目改动同一批文件、必须串行；哪些互不相交、可并行。
   这直接决定后续能派几个 worker。

## 已知的既有设计约束（写方案时必须遵守）

- `docs/46-frontend-styleguide.md` 是**前端风格宪法**，§6.1（引导弹框）、
  §7（双语硬约束、快捷键展示必须匹配平台真实绑定）是硬约束。
- `docs/58-feature-tips.md` §1.1：「教错快捷键比不教更糟」；
  §3.3 定义了 tips 触发优先级（上下文触发 > 未用能力 > 随机）。
- `docs/60-notify-ui-handoff.md`：打扰闸门契约，`tip:0 / update:1` 优先级，
  「半成品的 tips 不如没有」。
- `docs/56-onboarding-design.md`：黄金五分钟已覆盖头 5 分钟，68 不要重做首启引导。
- `CLAUDE.md` 的 Known Gotchas，尤其「Zustand selector 里不要调用返回新集合的
  store 方法」——涉及 store 改动的建议要避开这个坑。

## 边界（不要做）

- **不要改任何代码**。本 plan 只产出文档。
- **不要写新教程**。`docs/guide/` 已有 19 篇（另有 mcp-orchestration 一篇，共 21 个文件），
  缺的是路径不是内容。
- **不要重做首启引导**。docs/56 已覆盖。
- **不要碰发现性范围**（主页 README、tips 内容扩容）——那是 67 的地盘，正在并行推进。
- **不要提交 git**，除非 leader 明确指示。

## 验收

- `docs/68-*.md` 已创建，体例与 67/66 一致
- `CLAUDE.md` 文档引用表格加了对应行
- 每条写进计划的问题你都回代码复核过；复核不实的已删除并说明
- B2/B3 两条要么坐实后写入、要么明确标注「未坐实，实施前需验证」
- 文档里明确标注了条目间的文件冲突关系与可并行性

## 收尾

按 docs/65 观测契约上报。完成时说明：
最终写了几条、删了哪几条及理由、B2/B3 的实测结论、
以及你判断本 plan 素材里有误的地方。
