# 68 · 交互质量计划：快捷键体系 / 操作可逆性 / 空态一致性

> 计划文档，未排期到具体版本。可作为独立派工的交接件。
>
> 本文所有条目均由作者逐条回代码复核，行号以复核当时的工作树为准。
> 复核推翻的条目见 [§8 复核结果与删除记录](#8-复核结果与删除记录)——
> **不要跳过 §8**，素材里有两条原始判断被证伪，且证伪过程本身产出了两条新问题。

## 0. 与 67 的分界

[docs/67](./67-discoverability-plan.md) 与本文是同一个命题（「完善人机交互」）切出来的两块，
边界是**用户是否已经知道这个能力存在**：

| | 管什么 | 典型问题 |
|---|---|---|
| **67 · 发现性** | 用户不知道我们能干什么 | 主页讲不清卖点、tips 只有 4 条、教程有内容没入口 |
| **68 · 交互质量**（本文） | 用户知道了，但用起来别扭 | 快捷键按了没反应、关标签杀掉跑了 40 分钟的 agent、空态长得都不一样 |

两份文档不重叠。有一条明确的交界线在 tips 上：

- tips **内容扩容**（写更多条、覆盖编排能力）→ 67 / L2；
- tips **触发智能**（用量计数、上下文触发、轮换）→ 本文 §4.3。

两侧改同一批文件，必须串行——见 [§6 依赖与并行性](#6-依赖与并行性)。

## 1. 判轻重的尺子

条目按下面的量级排，不平铺：

```
不可逆损失  >  教错用户  >  效率损耗  >  一致性瑕疵
```

- **不可逆损失**：用户失去了拿不回来的东西（进程、未保存编辑、40 分钟的 agent 上下文）。
- **教错用户**：产品告诉用户「按这个键」，但按了没反应。
  [docs/58](./58-feature-tips.md) §1.1 原话是「教错快捷键比不教更糟」，
  [docs/46](./46-frontend-styleguide.md) §7 原话是「快捷键展示必须匹配平台真实绑定；宁可不显示也不显示错的」。
  这是本仓库自己写下的硬约束，违反它比效率问题严重。
- **效率损耗**：能做成，但要多点几次。
- **一致性瑕疵**：不影响完成任务，影响产品是否像一个整体。

按这把尺子，P1 只有一条（§2），P2 三条（§3），P3 三条（§4），P4 三条（§5）。

---

## 2. P1 · 不可逆损失

### 2.1 关闭标签会静默杀死运行中的 agent 会话

**现象**：关一个正在跑的 Claude/Codex 会话，与关一个空终端，待遇完全相同——
直接 `killSession`，没有任何提示。

**代码位置**：

| 路径 | 位置 | 关闭前检查什么 |
|---|---|---|
| 单个标签关闭 | `web/components/panes/Panel.tsx:171-182` → `doCloseTab:154-168` | 只看 `tab.pinned` 与 `tab.dirty` |
| 关闭其他 / 关闭右侧 | `Panel.tsx:193-220` `doBatchClose` | 只看 `t.dirty && !t.pinned` |
| Ctrl+W 快捷键 | `web/hooks/useShortcutRegistrations.ts:99-114` | **什么都不看**，且只 kill `tab.sessionId` 一个 |
| 删除布局 | `web/components/layoutbar/LayoutDeleteDialog.tsx:106-125` | **有确认弹窗**，且列出活跃终端数（`:97`） |

**为什么算问题**：`dirty` 是「编辑器有未保存内容」，它与「这个终端里有个 agent 正在干活」
是两个正交的维度。CC-Panes 自述的核心场景是长时无人值守派工——
最贵的那类标签恰好是 `dirty === false` 的那类。

`useTerminalStatusStore` 已经维护了每条会话的状态（`isBusyStatus` / `waitingInput`
在 `web/lib/interruptGate.ts:42` 就是这么用的），判据是现成的，只是关闭路径没读它。

**影响面**：每个用户、每天多次。误关的代价是一整段 agent 上下文
（Claude 侧可 `--resume` 找回，Codex 侧依赖 OSC 标题捕获的 resume id，
见 [docs/45](./45-codex-resume-capture-dead.md)，本身就不稳）。

**注意 LayoutDeleteDialog 是正面样板，不是问题**。它已经做对了：
统计将被杀的会话数、popped 窗口数、SSH/restoring 数并让用户确认。
本条要做的是**把它的形态推广到标签关闭路径**，而不是新发明一套。

### 2.2 「恢复已关闭标签」已经实现了，但一个调用方都没有

复核 §2.1 时发现的：撤销能力**已经写完并落在 store 里**，只是从未接线。

```
web/stores/usePanesStore.ts:1697-1717   closeTab 里 push 进 closedTabs
web/stores/usePanesStore.ts:1243-1266   closePane 里批量 push
web/stores/usePanesStore.ts:2232-2256   reopenClosedTab(paneId) —— 弹栈 + addTab(resumeId)
web/stores/panesStoreTypes.ts:205       类型已导出
web/i18n/locales/{en,zh-CN}/panes.json:54  文案已写好："恢复已关闭标签 ({{count}})"
```

`grep reopenClosedTab web/ --glob '!*.test.*'` 的结果只有定义与类型声明，**零调用方**。
i18n 里那句带计数的文案说明当初是打算做一个菜单项的，做到一半停了。

同时 `closedTabs` 是 push-only：`partialize`（`usePanesStore.ts:3032`）只持久化
`layouts` / `currentLayoutId`，所以它不会写进 localStorage，但在单次运行里无上限增长、
且永远没有消费者。这是轻量泄漏（每项只是几个字符串字段），量级远小于「撤销能力缺失」本身。

**这条把 2.1 的成本压得很低**：`reopenClosedTab` 已经带 `resumeId` 走 `addTab`，
意味着恢复出来的不是空终端，而是能 resume 回原对话的标签。接线成本远小于重写。

### 2.3 交付粒度与验收

| 子项 | 交付物 | 验收标准 |
|---|---|---|
| **T1-a** 关闭前的活跃会话确认 | `Panel.tsx` 单个 + 批量路径读 `useTerminalStatusStore`，busy/waitingInput 时走确认弹窗（形态对齐 `LayoutDeleteDialog`：列出条数与标题，不是一句「确定吗」） | 起一个 busy 会话 → Ctrl+W 与右键关闭都弹确认；空终端不弹；`dirty` 的既有行为不回退 |
| **T1-b** Ctrl+W 与 UI 关闭同源 | `useShortcutRegistrations.ts` 的 `close-tab` handler 改为复用 Panel 的关闭入口（pinned / dirty / 活跃会话三重检查 + `collectTerminalSessionIds` 全量 kill） | 分屏内两条 PTY 的标签，Ctrl+W 后 `list_sessions` 里两条都消失；pinned 标签 Ctrl+W 无反应 |
| **T1-c** 接上撤销入口 | 标签栏右键菜单 + 命令面板各加一项调 `reopenClosedTab`；`closedTabs` 加上限裁剪（建议 20） | 关一个 Claude 标签 → 恢复 → 新标签带原 `resumeId`；连关 30 个后 `closedTabs.length === 20` |

> ✅ **T1-b 已由 L0 完成并合入 main**（commit `30f9e3e`，merge `d8d42cb`）。
>
> 实现方式与本文预设略有不同，派 T1-a / T1-c 前请以现状为准：
> 关闭标签一族逻辑已抽出为 `web/components/panes/useTabClosing.ts`，
> `close-tab` handler 缩为派发 `CLOSE_ACTIVE_TAB_EVENT`，由激活面板
> （守卫 `usePanesStore.getState().activePaneId !== paneId` 则忽略）
> 消费同一个 `handleCloseTab`。三个入口一份实现。
> `Panel.tsx` 因行数棘轮拆分，baseline 由 668 下调至 561。
>
> **所以 T1-a 的落点变了**：活跃会话确认要加在 `useTabClosing.ts` 里，
> 不再是 `Panel.tsx:154-182`。T1-c 的撤销入口同理。

### 2.4 批量关闭时 kill 失败会连弹 toast

L0 顺带把 kill 失败从 `handleErrorSilent` 升为 `handleError`（toast + 日志）——
这是有意的，原先 Ctrl+W 路径是裸 `.catch(console.error)`，用户完全看不见失败。
**升级本身正确且已获批准保留**，但它同时改变了鼠标点 × 与批量关闭的行为（原为静默）。

**不会误报**，前提已核实：`terminalService.killSession`
（`web/services/terminalService.ts:636`）invoke 的是 `kill_terminal_idempotent`，
`src-tauri/src/commands/terminal_commands.rs:314-318` 把
`is_idempotent_kill_error` 判为 `Ok(())`，覆盖 `AppError::NotFound(_)` 与
`"already exited"`（Rust 单测 `terminal_commands.rs:596-614` 锁住）。
所以能冒出来的都是真失败。

**问题只在重复呈现**：批量路径（关闭其他 / 关闭右侧）一次 kill N 个会话，
而真失败通常是**系统性**的（daemon 挂了、IPC 断了）——N 个会一起失败，
弹 N 条内容相同的 toast。`web/components/layout/AppShell.tsx:42` 的
`<Toaster>` 未设 `visibleToasts`，sonner 默认可见 3 条、其余排队。

**处置**：按「一次关闭操作」聚合成一条 toast（或对同一错误做去重），
改动范围限于 `useTabClosing.ts` 的批量分支。

**优先级 P4**：触发条件本身已是「后端全挂」的严重态，此时连弹 toast
只是雪上加霜，不是首要故障。但成本很小，可以随手带上。

### 2.5 更新安装要重启，而会话存活性从未被验证或告知（待评估议题）

**起因是一次对标**。Orca 的更新卡片正文只有两句：
「Orca v1.4.159-rc.0 已准备就绪。」+「**会话不会被中断。**」——
第二句主动打消顾虑，是在把「更新」从一个需要下决心的动作降级为顺手一点。

我们的卡片方向正相反：

| 位置 | 文案 key | 说的是 |
|---|---|---|
| `UpdateNotification.tsx:314` | `updateRestartTitle` | 需要重启 |
| `:315` | `updateRestartWarning` | 重启警告 |
| `:317` | `updateRestartBusyWarning` | 有会话在跑时**再警告一次** |

安装路径是 `downloadAndInstallUpdate()` → `relaunch()`（`updaterService.ts`）。

**但这可能是在自我贬低。** CLAUDE.md 明确记着：

> orchestrator 死了不等于没救：**daemon 是跨 app 重启存活的锚点**。
> PTY 会话真身活在 daemon 里（`runtime/daemon-manifest.json` 给出 addr+token），
> orchestrator 随 app 生死。

而 [docs/66](./66-0115-session-recovery-promotion.md) 计划在 0.11.5 把「会话恢复」转正。
也就是说：**relaunch 之后会话很可能还在**，我们只是没验证、没说、还反过来警告用户。

**三个必须先答的未知**（顺序不能反）：

1. `relaunch()` 之后，daemon 里的 PTY 会话是否真的存活、前端能否自动重接？
   （注意 daemon 与 app 的生命周期绑定关系——`relaunch` 是否会连带杀掉 daemon，
   取决于它是不是 app 的子进程 / 是否在同一个 Job Object 里，这一点必须实测，不能推断）
2. 若存活：为什么卡片还在警告？这就变成一个**纯文案问题**，成本极低收益很高。
3. 若不存活：它与 docs/66 的会话恢复是什么关系？能否复用那条恢复链路？

**处置：先验证，再定文案。不要反过来——照抄「会话不会被中断」而实际会断，
比现在的警告严重得多**（那是承诺了做不到的事，属于「教错用户」的更坏形态）。

**优先级待定**，取决于验证结果：
- 会话存活 → 纯文案 + 一次验证，成本极低，应尽快做
- 会话不存活 → **P1 不可逆损失**（点一下更新，所有在跑的 agent 上下文全没），
  且当前警告文案的存在说明我们知道这件事却只是警告，没给出路

**这条不要与 L7（更新提示可达性）混在一起做。** L7 只管让卡片能出现，
本条管的是卡片说什么、以及背后的能力边界，需要先做验证实验。

---

## 3. P2 · 教错用户

### 3.1 终端聚焦时 7 个主快捷键静默失效，而 UI 仍显示它们可用

**现象**：终端聚焦（**这是产品的默认状态**，用户绝大多数时间都在终端里）时，
下面 7 个动作的快捷键被放行给终端，主程序不响应；但设置页与命令面板照常展示这些绑定。

**代码位置**：`web/stores/useShortcutsStore.ts:16-24` 定义清单，
放行发生在 `handleKeydown:150-152` 与 `shouldTerminalHandleKey:178-180`。
展示侧无任何区分：`web/components/settings/ShortcutsSection.tsx:92-113` 平铺全部绑定，
`web/components/CommandPalette.tsx:153-155` 对每个已注册动作直接渲染 `formatKeyCombo(bindings[action.id])`。

**源码注释里逐条写了当初放行的理由**（`useShortcutsStore.ts:7-14`），提方案前必须读懂：

| action | 默认键 | 让位给谁 |
|---|---|---|
| `toggle-sidebar` | Ctrl+B | Claude Code `task:background` |
| `new-tab` | Ctrl+T | Claude Code `app:toggleTodos` |
| `close-tab` | Ctrl+W | readline `delete-word` |
| `toggle-mini-mode` | Ctrl+M | 终端 Enter（0x0D） |
| `split-right` | Ctrl+\ | 终端 SIGQUIT |
| `split-down` | Ctrl+- | 部分 TUI 应用 |
| `command-palette` | Ctrl+K | readline `kill-line` / Claude Code 常用 |

**这 7 条理由都成立，不要建议「移出清单」。** Ctrl+W 让给 readline 尤其不能动——
在终端里按 Ctrl+W 期望删词却关掉了整个会话，比快捷键不生效严重得多。

**真正的问题在别处，有两层**：

1. **展示与实际不符**，直接违反 docs/46 §7「宁可不显示也不显示错的」。
   用户在设置页看到 `Ctrl+B → 切换侧栏`，在终端里按了没反应，只能得出「这软件有 bug」的结论。
2. **逃生通道本身也在清单里**。`command-palette` 是这 7 条中的一条——
   而命令面板是所有被屏蔽动作**唯一的**替代入口
   （`CommandPalette.tsx:127-129` 把除 `command-palette` 与数字键外的动作全列了出来，
   `COMMAND_PALETTE_TOGGLE_EVENT` 的唯一 dispatcher 就是那个快捷键，
   `useShortcutRegistrations.ts:123`，没有任何按钮或菜单能打开它）。
   于是在默认状态下：7 个快捷键不通，唯一的备用路径也不通。

**候选方案**（需要产品决策，本文不替它拍板）：

- **方案 A（成本最低，只治展示）**：设置页与命令面板对这 7 条打「终端内不生效」标记，
  并在设置页顶部一句说明。符合 §7，但用户仍然没有替代路径。
- **方案 B（治逃生通道）**：给命令面板一个不依赖快捷键的入口
  （标题栏按钮 / 状态栏 / 右键菜单），并把 `command-palette` 之外的 6 条
  在面板里保持可执行。A + B 一起做，这 7 个能力在终端里就都有路径了。
- **方案 C（前缀键）**：给终端一个 leader key（如 Ctrl+A，形如 tmux），
  `Ctrl+A` 后续按键交回主程序。能力最完整，但引入一套新的按键心智，
  且要处理与 tmux/screen 自身前缀键的二次冲突。成本最高，建议作为后续项而非首发。

**建议先做 A + B**：A 消除「教错用户」，B 恢复可达性，两者加起来不改任何放行语义，
风险面最小。C 单开一份评估。

**影响面**：全部用户、全程。这是本文里唯一一条「默认状态下就是错的」。

### 3.2 三个已注册动作在设置页里根本不存在，且标签是硬编码英文

**现象**：`show-explorer` / `show-sessions` / `show-files` 注册于
`useShortcutRegistrations.ts:192-206`，但 `cc-panes-core/src/models/settings.rs:1053-1079`
的 `ShortcutSettings::default()` 里没有它们（默认表共 17 条具名 + 18 条数字 = 35 条，已逐条核对）。

`ShortcutsSection.tsx:92` 的渲染源是 `Object.entries(value.bindings)`——
**没有 binding 的动作永远不出现在设置页，因此永远不可能被绑定**：想绑必须先有绑定，是个死结。

附带：这三条的 `label` 是硬编码英文字符串（`:194` `"Explorer"`、`:199` `"Sessions"`、`:204` `"Files"`），
其余 17 条全走 `i18n.t(..., { ns: "shortcuts" })`。违反 docs/46 §7 双语硬约束。

**一处需要修正原始盘点的说法**：这三个动作**不是完全不可达**——
`CommandPalette.tsx:127` 只排除了 `command-palette` 与数字键，
所以它们出现在命令面板里，可以点击执行。不可达的是**绑定**，不是**执行**。
但这个「可达」经由 Ctrl+K，而 Ctrl+K 在终端聚焦时不通（§3.1），所以实际可达性依然很差。

**交付粒度**：

| 子项 | 交付物 | 验收标准 |
|---|---|---|
| **T2-a** 补默认绑定 | `settings.rs` 的 `ShortcutSettings::default()` 加这 3 条（键位需避开现有 35 条，`merge_missing_defaults` 会自动跳过与已有 combo 冲突的默认，见 `settings.rs:501-503`） | 全新数据目录启动 → 设置页快捷键列表出现这 3 项；已有用户升级后也出现（走 `merge_missing_defaults`） |
| **T2-b** 补 i18n | `web/i18n/locales/{en,zh-CN}/shortcuts.json` 加 3 个 key，`useShortcutRegistrations.ts:194,199,204` 改走 `i18n.t`，`ShortcutsSection.tsx:14-32` 的 `actionI18nKeys` 同步加 3 条 | 切中/英文，设置页与命令面板里三项均本地化；`actionI18nKeys` 未命中时的兜底（`:54` `return action`）不再被这 3 条触发 |

T2-a 与 T2-b 改不同层但语义耦合（T2-a 不做，T2-b 的设置页部分看不到效果），建议同一个 worker 串行做完。

### 3.3 tips 的「用过没用过」判据其实是「有没有给你看过」

**现象**：tips 系统认为「用户已经知道 Ctrl+K」的唯一依据是「我们给他弹过 Ctrl+K 的提示卡」。
天天用 Ctrl+K 的用户仍然会被教 Ctrl+K；4 条展示完之后 tips 永久沉默。

**代码位置**：

- `web/components/tips/FeatureTips.tsx:180-191` `markSeen`：只在提示卡出现并被响应时写
  `seen`（展示过）与 `tried`（点了「试试」按钮）。
- `FeatureTips.tsx:77` `selectFeatureTip` 的候选过滤只看 `seen`。
- `web/types/settings.ts:161-168` `TipsSettings` 的全部字段是
  `enabled / lastShownAt / seen / tried / dismissRun / sessionCount`——
  **没有任何一个字段记录「这个功能被实际使用过几次」**。
- `FeatureTips.tsx:78` `candidates.length === 0` → `return null`：候选耗尽即永久静默，无轮换。

**这直接落空了 docs/58 §3.3 的两条**（原文）：

> 1. **上下文触发（最有价值）**：观察到用户手动做了 N 次可被更快路径替代的操作……
>    需要一个**本地**动作计数器（不外传）；
> 2. **未用能力**：某功能可用但从未被使用过 X 个会话；
>
> MVP 可以只做 2+3，但 1 是这个系统真正的价值来源，**不要长期缺席**。

第 2 条也没实现——「从未被使用过」需要用量计数，仓库里没有。
现状只做到了第 3 条（随机兜底）。

**实测数据**（本机两个数据目录，2026-07-27 读取）：

| 数据目录 | `sessionCount` | `seen` | `tried` |
|---|---|---|---|
| `~/.cc-panes-dev/` | 131 | `["layout-switcher"]` | `[]` |
| `~/.cc-panes/` | 3 | `[]` | `[]` |

dev 实例启动 131 次只弹出过 1 条 tip、0 次被采纳。
叠加 `BASE_TIP_INTERVAL_MS = 3 天`（`FeatureTips.tsx:17`）与
`dismissRun >= 2` 时翻倍（`:63-65`），系统实际处于近乎静默的状态。
**在这个基数上把 tips 从 4 条扩到 10 条（67 的范围）不会改变任何事**——
扩容的收益被触发层吃掉了。这是 67 与 68 必须协调的地方。

**交付粒度**：

| 子项 | 交付物 | 验收标准 |
|---|---|---|
| **T3-a** 用量计数 | `TipsSettings` 加 `usage: Record<string, number>`（Rust 侧同步，注意 §4.2 的 HashMap 顺序问题——这里用 map 无所谓，因为不参与渲染顺序）；在 `useShortcutsStore.handleKeydown` 命中 action 时 +1（节流写盘） | 手按 Ctrl+K 三次 → 配置里 `usage["command-palette"] >= 3`；`selectFeatureTip` 把 `usage[id] > 0` 的 tip 排除 |
| **T3-b** 候选耗尽后的轮换 | `selectFeatureTip` 在 `candidates.length === 0` 时按 `lastShownAt` 最久远 + `usage === 0` 重新入池，而不是 `return null` | 把 4 条全部标 `seen` → 经过一个 interval 后仍能选出一条（且优先选 `usage === 0` 的） |
| **T3-c** 上下文触发 | docs/58 §3.3 第 1 条：连续 N 次用鼠标菜单做了有快捷键的操作 → 触发对应 tip | 连续 3 次用右键菜单新建标签 → 下一个空闲边界弹出 `unified-launcher` tip |

T3-c 是 docs/58 说的「真正的价值来源」，但也最重。若只能做一部分，**做 T3-a**——
它同时解决「教已经会的东西」和为 T3-c 提供数据底座。

---

## 4. P3 · 效率损耗

### 4.1 快捷键冲突只拒绝，不给出路

**代码位置**：`ShortcutsSection.tsx:70-74`。命中 `findConflict`（`useShortcutsStore.ts:119-130`）
即 `toast.warning` 并 `return`，不写入。

**为什么算问题**：toast 告诉用户「Ctrl+K 已被『命令面板』占用」，然后就结束了。
用户想完成「把 Ctrl+K 给别的动作」，必须：退出录制 → 在 35 条无搜索的列表里翻找「命令面板」→
把它改成别的键（这一步可能又撞冲突）→ 回到原动作 → 重新录制。**最少 4 步定位**。

标准做法是在冲突时提供「替换并解绑原动作」——冲突信息已经在手里（`findConflict` 返回了 action id），
只差一个确认交互。

**影响面**：只影响改快捷键的用户，但这类用户改的时候一定会撞上（35 条默认已经占满了常用组合）。

### 4.2 快捷键设置页缺 reset / 搜索 / 解绑，且列表顺序每次启动都不一样

`ShortcutsSection.tsx` 全文 118 行，没有恢复默认、没有过滤框、没有清除绑定。
改坏了只能去删 `config.toml`。`switch-tab-1..9` + `switch-layout-1..9` 共 18 条数字项
占了列表一半，把真正需要调的 17 条挤到看不见。

`SearchableSetting sectionId="shortcuts-list"`（`:90`）把整个 35 条列表包成
**一个**搜索锚点，所以设置页全局搜索最多把用户带到列表顶部，落不到具体某一条。

**复核时发现的新问题（原素材未提，已实测坐实）：列表顺序是随机的。**

`ShortcutSettings.bindings` 在 Rust 侧是 `HashMap<String, String>`
（`cc-panes-core/src/models/settings.rs:491`），TOML 落盘与 IPC 序列化都按 HashMap
的迭代顺序输出，而 std 的 `RandomState` 每个实例种子不同 → **顺序每次运行都不一样**。
前端 `ShortcutsSection.tsx:92` 直接 `Object.entries(...)` 渲染，不排序。

实测（`config.toml` 的 `[shortcuts.bindings]` 段，两个数据目录）：

```
~/.cc-panes-dev/   开头： switch-tab-9, toggle-fullscreen, voice-input, switch-layout-2, ...
~/.cc-panes/       开头： toggle-sidebar, switch-layout-9, focus-pane-left, new-tab, ...
```

两份都不是字母序、不是插入序、彼此不同——确认是哈希序。
后果：用户每次打开设置页，35 条的排列都变了，肌肉记忆完全无法建立；
上一次改过的那条在哪，只能重新扫一遍。这条本身就是 §4.2 里最伤的部分。

**交付粒度**（这几条都改 `ShortcutsSection.tsx`，**必须由同一个 worker 串行做**）：

| 子项 | 交付物 | 验收标准 |
|---|---|---|
| **T4-a** 固定顺序 | 前端按稳定顺序渲染（建议：按 `actionI18nKeys` 的声明序分组，数字项折叠为一组），或后端换 `BTreeMap`。**前端排序更稳**——后端换 map 类型会影响 TOML 落盘格式与 `merge_missing_defaults` 的行为 | 连开三次应用，设置页列表顺序完全一致；`config.toml` 的乱序不影响展示 |
| **T4-b** 分组 + 搜索 | 按「窗口 / 标签 / 分屏 / 布局 / 其他」分组；顶部加过滤框；`switch-tab-*` 与 `switch-layout-*` 折叠为两组可展开项 | 输入「布局」只剩布局相关；折叠状态下列表 ≤ 20 行 |
| **T4-c** 每条一个搜索锚点 | `SearchableSetting` 下沉到每一行（`sectionId` 用 action id），替换掉 `:90` 的单锚点 | 设置页全局搜索「迷你模式」直接高亮到那一行，不是列表顶部 |
| **T4-d** reset + 解绑 | 每行一个「清除」，Section 顶一个「恢复默认」（带二次确认） | 清除后该动作在 `bindings` 中消失且快捷键不再触发；恢复默认后 35 条回到 `ShortcutSettings::default()` |
| **T4-e** 冲突可解（§4.1） | `findConflict` 命中时弹确认：「Ctrl+K 当前绑定到『命令面板』，替换？」确认则解绑原动作再写入 | 把已占用的键绑给另一个动作 → 确认后原动作变为未绑定，新动作生效，无 toast 拒绝 |

**T4-d 的一个坑**：解绑后 `merge_missing_defaults`（`settings.rs:495-506`）在下次启动时
会把默认值**加回来**（它只跳过 key 已存在或 combo 已被占用的情况，不认识「用户主动解绑」）。
要么引入显式的 `null`/空串表示「已解绑」，要么接受「解绑 = 恢复默认」的语义并在 UI 上说清。
**这是实施前必须拍板的点**，不要让 worker 自己猜。

---

## 5. P4 · 一致性瑕疵

### 5.1 空状态没有统一形态

`web/components/ui/EmptyState.tsx` 存在（图标 + 标题 + 说明 + 可选 CTA），
被 **9 个**组件文件使用：`WorkspaceTree` / `RecentLaunches` / `RightDock` /
`VersionListSidebar` / `TodoManager` / `ProvidersPanel` / `AiPanelHistoryList` /
`TaskDetailPanel` / `OrchestrationFullView`。

`empty|没有|暂无`（忽略大小写，排除 `*.test.*`）在 `web/components/` 下
命中 **128 处 / 53 个文件**。这个数字是个粗筛，不能直接当「有 119 个坏空态」读——
里面混了变量名（`const empty = ...`）、无结果状态、注释。

**已抽样核实的两类**：

| 位置 | 形态 | 判断 |
|---|---|---|
| `providers/LaunchProfilesPanel.tsx:1133-1139, 1578, 1973` | 走了 i18n（`t("listEmptyWorkspace")` 等），但只是一个 `<div>` 裸文案，无图标、无 CTA | **真问题**：`listEmptyWorkspace` 这种「当前工作空间没有启动配置」的状态，正是最该给「新建一个」CTA 的地方（docs/46 §8「缺数据给直接获取动作」） |
| `mobile/MobilePrototype.tsx:432, 495, 548, 650, 663, 671, 874, 919` | **硬编码中文字面量**，完全没走 i18n | **真问题，但是另一类**：这是 docs/46 §7 双语硬约束的违反，不是空态形态问题。原型路由，优先级另议 |
| `filetree/FileSearchView.tsx:181, 189` | `:181` 是变量名；`:189` 是「无搜索结果」 | **不是问题，已从清单剔除**。无结果 ≠ 空态，搜索无结果不应该配图标和 CTA |

**为什么算问题**：空态是新用户遇到最多的界面。有没有 CTA 目前是随机的——
同一个应用里，有的空面板告诉你下一步做什么，有的只写「暂无」。

**交付粒度**：这条**不要一把梭**。先交一份审计（把 128 处过一遍，分成
「真空态缺 CTA」/「无结果状态，保持现状」/「变量名或注释，忽略」三类），
再按面板逐个改造。审计本身就是一个可独立派工的单元。

**验收**：审计产物是一张表（文件:行 → 分类 → 处置）；改造阶段每个面板的空态
都有图标 + 一句说明 + （如果存在有意义的下一步）一个 CTA。

### 5.2 tip 演示动画没走 duration token

`web/components/tips/featureTipRegistry.tsx:104` 用 Tailwind 的
`motion-safe:animate-pulse motion-reduce:animate-none`。

docs/46 §6.1 原文：「动画必须使用现有 duration/easing token，
并在 `prefers-reduced-motion` 下停用位移与循环」。
`motion-reduce:animate-none` 那半边是合规的，**问题只在时长来源**——
`animate-pulse` 是 Tailwind 内置的 2s 曲线，不是仓库的
`var(--dur-*)` token（用法见 `ShortcutsSection.tsx:102`）。

当前只有 1 处。**但这条的价值在时机**：67 要把 tips 从 4 条扩到 10 条，
每条都带一个 visual，现在不定规矩，偏差会被复制 10 份。
所以本条应该在 67 的 tips 扩容**之前**做掉，成本是一行。

> ⚠️ **时机已经错过一半**：67 的 tips 扩容（L2）已经派出，
> 其 plan 里明确要求「新增演示必须用 `var(--dur*)` token，
> 现有 `MiniModeVisual` 的 `animate-pulse` 是既存偏差，不要复制」。
> 所以**新增的 6 条不会带偏差**，但 `featureTipRegistry.tsx:104` 这既有一处
> 仍未修——它现在是全库唯一的反例，改它的人要小心与 L2 的同文件冲突（见 §6）。

### 5.4 tip 的终端放行限制说明偏长，视觉配重待评

L0 新增的 `featureTips.terminalPassthroughHint`
（`web/i18n/locales/{en,zh-CN}/settings.json:246`）中文 47 字，
以段落形式落在 tip 左栏的键位 badge 与「重新绑定」按钮之间。

功能与无障碍都正确（信息在左栏可获得、与「未绑定」降级正交），
**问题只在密度**：对照 docs/46 的文案密度约定，一段 47 字的说明夹在
两个交互元素中间，会把左栏的视觉重心从「主行动」拉走——
而 docs/58 §1.1 的原则是「tip 的价值在于用户真的用一次」，主行动不该被稀释。

**处置**：需要设计侧扫一眼配重，可能的方向是压缩文案、
或改为更轻的行内提示形态。**不要为了短而说不清限制**——
说不清就退回了「教错快捷键」，那比长更糟。

**优先级 P4**。这条与 §5.2 都在 tips 目录，且 L2 正在改同一批文件，
应等 L2 合入后再动。

### 5.3 打扰闸门的「有弹窗打开」判定是手工枚举

`web/lib/interruptGate.ts:71-87` 的 `hasOpenDialog()` 逐个 `||` 列出 12 个 flag。

**复核结论：当前是同步的。** `useDialogStore.ts` 里的 `*Open: boolean` 字段
恰好也是 12 个（`settingsOpen` / `journalOpen` / `localHistoryOpen` / `gitTimelineOpen` /
`sessionCleanerOpen` / `todoOpen` / `plansOpen` / `selfChatOpen` / `aiPanelOpen` /
`onboardingOpen` / `workspaceEnvironmentOpen` / `launcherOpen`），一一对应，**没有漏项**。

所以这**不是当前缺陷，是结构脆弱性**：下一个加对话框的人只要忘了同步这份手抄清单，
tip 或更新卡就会盖在对话框上，而且不会有任何编译错误或测试失败提醒他。
CLAUDE.md 里记了多起同类事故（快捷键注册项 vs 设置页、worktree 项目写入 vs 回收）。

**处置**：改为从 store 派生（遍历 state 里所有 `*Open` 结尾的 boolean），或加一条
断言两侧数量一致的单测。**成本几行，收益是这类事故永久消失**。

**注意 CLAUDE.md 的 Known Gotchas**：如果选「从 store 派生」，
派生函数不要写成 Zustand selector 返回新集合——`hasOpenDialog()` 目前在
`useCallback` 里通过 `.getState()` 调用（`interruptGate.ts:110`），是渲染外调用，安全；
保持这个形态即可，不要改成 `useDialogStore((s) => derive(s))`。

---

## 6. 依赖与并行性

**同一批文件 = 必须串行**：

| 文件 | 被哪些条目改 | 结论 |
|---|---|---|
| `web/components/settings/ShortcutsSection.tsx` | T4-a/b/c/d/e（§4.1 §4.2）、§3.1 方案 A 的标注、§3.2 的 `actionI18nKeys` | **一个 worker 全包**。这是本计划里最集中的冲突点 |
| `cc-panes-core/src/models/settings.rs` | T2-a（补 3 条默认）、T3-a（`TipsSettings` 加 `usage`）、T4-d（解绑语义） | 串行。改动都小，建议并入对应 worker 但**排出先后**：T2-a → T4-d → T3-a |
| `web/hooks/useShortcutRegistrations.ts` | ~~T1-b~~（**已由 L0 完成**）、T2-b（3 条 label） | T1-b 已关闭，T2-b 现可独立动 |
| `web/components/tips/featureTipRegistry.tsx` | §5.2（duration token）、§5.4（文案密度）**与 67 的 tips 内容扩容** | **跨计划冲突，且 67/L2 已先开工**。§5.2/§5.4 必须**等 L2 合入后**再动，不能抢在前面 |
| `web/components/tips/FeatureTips.tsx` | T3-a/b/c | 一个 worker，同样等 L2 合入 |
| `web/components/panes/useTabClosing.ts` | T1-a、T1-c、§2.4（toast 聚合） | 一个 worker。**注意落点已从 `Panel.tsx` 迁到此文件**（L0 抽出） |

**互不相交 = 可并行**，建议这样切 worker：

```
W1  §2 操作可逆性     useTabClosing.ts / usePanesStore.ts
                      ✅ L0 已合入，前置依赖解除；T1-b 已关闭，只剩 T1-a/T1-c/§2.4
                      不再碰 useShortcutRegistrations.ts（close-tab 已缩为一行派发）
W2  §3.2 + §4 快捷键  ShortcutsSection.tsx / settings.rs / i18n shortcuts.json /
                      useShortcutRegistrations.ts(labels)
                      ✅ 与 W1 的文件冲突已消失（W1 落点迁到 useTabClosing.ts），可并行
W3  §3.3 tips 触发    FeatureTips.tsx / settings.rs(TipsSettings) / useShortcutsStore.ts(计数)
                      ⚠ 等 67/L2 合入后再派
W4  §5.1 空态审计     只读产出，与所有人不冲突，可最先派
W5  §5.3 闸门去枚举   interruptGate.ts / useDialogStore.ts，与所有人不冲突
```

**§5.2 与 §5.4 不单独派 worker**——都是小改动，随 W3 顺手带上。
原计划是「抢在 67 扩容之前做掉」，但 **L2 已先开工，这个时机过了**；
改为等 L2 合入后随 W3 处理。L2 的 plan 已要求新增的 6 条不带偏差，
所以只剩既有那一处（`featureTipRegistry.tsx:104`）。

§3.1 的方案 A/B/C 需要产品决策后才能派，不在上面五个 worker 里。

**§2.4 归入 W1**（同在 `useTabClosing.ts`）。

## 7. 明确不做

- **不做首启引导改造**。[docs/56](./56-onboarding-design.md) 的黄金五分钟已覆盖头 5 分钟，
  本文只在 §8 记录一个待决策点（B4），不动实现。
- **不碰发现性范围**。主页 README、tips 内容扩容是 67 的地盘，正在并行推进。
  本文只动 tips 的**触发层**，不加也不改任何一条 tip 的内容。
- **不写新教程**。~~`docs/guide/` 已有 19 篇……缺的是路径不是内容。~~
  ⚠️ **这条的前提在 67 那边已被推翻**：guide 覆盖完好的是上一代能力，
  AI 面板 / 右坞 / 浏览器 tab / skill 体系四项**教程里完全不存在**，
  67 已破例补写四篇（`17-ai-panel` / `18-skills` / `19-right-dock` / `20-browser-tab`，
  现共 20 篇 + `mcp-orchestration` + 索引）。
  对**本文**而言结论不变——68 的条目都是交互质量问题，不需要新教程；
  但如果实施 §3.1 方案 A/B（给快捷键限制加说明）时发现需要文档落点，
  按 67 的先例处理，不要因为这条就硬扛。
- **不动 `TERMINAL_PASSTHROUGH_ACTIONS` 的放行语义**（§3.1）。7 条理由都成立，
  尤其 Ctrl+W → readline `delete-word` 不能动。要动也是先做前缀键（方案 C），
  单开评估，不塞进本计划。
- **不引入新的快捷键前缀键体系**（方案 C）作为首发。
- **不为一致性去重写 `MobilePrototype.tsx`**。它的 8 处硬编码中文是真问题，
  但属于双语约束而非交互质量，且是原型路由，另开条目。

---

## 8. 复核结果与删除记录

原始素材 14 条（A1–A10、B2–B4），逐条回代码复核后的处置：

### 8.1 删除（复核不实）

**B2 · 重复 combo 导致触发不确定 —— 删除，前提被证伪。**

原始判断：「`settings.rs:1376-1387` 的测试明确断言用户自定义 combo 与默认 combo 共存，
推理上会产生同一个键触发不同动作」。

**读反了。** 那个测试叫 `merge_missing_defaults_does_not_create_binding_conflicts`，
断言的是**不会共存**——`assert!(!settings.bindings.contains_key("focus-pane-left"))`：
用户把 `Alt+Left` 绑给了 `custom-action`，默认里同键的 `focus-pane-left` 就**不会被加进来**。

实现侧的守卫在 `settings.rs:501-503`：

```rust
if self.bindings.values().any(|value| value == &key_combo) {
    continue;
}
```

前端也挡着（`ShortcutsSection.tsx:70-74` 的 `findConflict`）。
两道闸门之间，应用内路径无法产生重复 combo，只有手改 `config.toml` 能做到。
残余风险是真的（重复时 `handleKeydown:145-159` 取 `Object.entries` 的第一个匹配，
而那个顺序是哈希序，见下），但触发条件是手工编辑配置文件，不构成计划条目。

**但这条复核的副产品坐实了一个更大的问题**：追查「`Object.entries` 顺序稳不稳」时，
实测两个数据目录的 `config.toml`，确认 `HashMap` 哈希序会让**整个快捷键设置页每次启动都重排**。
这条已写入 §4.2（T4-a），量级比原 B2 大得多。

### 8.2 复核后降级或改写

**A2 · 关闭标签杀会话 —— 保留为 P1，但原描述有两处不准，已改写（§2）。**

1. 「`LayoutDeleteDialog.tsx:115`（删布局连带杀会话）」被列为同类问题，**但它其实做对了**：
   `:97` 就在弹窗里列出将被杀的活跃终端数、popped 窗口数、SSH/restoring 数。
   本文把它改写为**正面样板**，让标签关闭路径对齐它，而不是把它一起改掉。
2. 「无 undo、无『最近关闭的标签』恢复入口」**不成立**：
   `usePanesStore.ts:2232-2256` 的 `reopenClosedTab` 与 `closedTabs` 都已实现，
   i18n 文案也写好了（`panes.json:54`）。真实情况是**零调用方**——功能做完了没接线。
   这把修复成本从「新建撤销机制」压到「接两个入口 + 加个上限」，是本次复核里对排期影响最大的一条。

**A7 · 打扰闸门手工枚举 —— 从「缺陷」降级为「结构脆弱性」（§5.3）。**
逐个核对 `useDialogStore.ts` 与 `interruptGate.ts:71-87`：两侧都是 12 项，
**当前完全同步，没有漏项**。原描述说「漏一个 → tip 盖在对话框上」是把风险写成了现状。
问题依然值得修（下一个加对话框的人不会有任何提醒），但优先级从中降到 P4。

**A9 · 空态没有统一形态 —— 保留，但数字与抽样都需修正（§5.1）。**
- `EmptyState` 的 9 个使用方**完全正确**，逐一核对无误。
- 「`empty|没有|暂无` 命中 249 处 / 118 个文件」复现不出来。我的口径
  （忽略大小写、排除 `*.test.*`）是 **128 处 / 53 个文件**；
  原数字应该是把测试文件算进去了。测试里的 `empty` 与产品空态无关，不该进分母。
- `FileSearchView.tsx` 的 2 处**从清单剔除**：一处是变量名，一处是「无搜索结果」——
  无结果状态不该配图标和 CTA，不是空态问题。
- `LaunchProfilesPanel.tsx` 的 3 处**不是「手写裸文本」**：它们走了 i18n
  （`t("listEmptyWorkspace")` 等），问题是绕过了 `EmptyState` 原语（无图标无 CTA），不是没翻译。
- `MobilePrototype.tsx` 的 8 处**确实是硬编码中文**，但那是 docs/46 §7 双语约束的违反，
  与空态形态是两件事，已在 §7 明确排除出本计划。

**A1 · Ctrl+W 漏杀分屏会话 —— 本文写作时尚未落地，现已由 L0 修复并合入。**

写作当时 `useShortcutRegistrations.ts:99-114` 仍是未修版本（只 kill 单个
`tab.sessionId`、无 pinned 检查、无 dirty 确认、错误只 `.catch(console.error)`），
因此本文把它作为 T1-b 的前置依赖记录，而非当作已修。

**后续状态（2026-07-27 更新）**：L0 已合入 main（`30f9e3e` / merge `d8d42cb`），
经独立审查验收——`npx tsc --noEmit` 与 `npm run test:run` 均 EXIT=0
（3117 tests 全通过），新增 7 条测试，其中分屏用例断言的是 `killSession`
的**调用集合**精确相等（多杀少杀都会挂）。
**§2.3 的 T1-b 已关闭，T1-a / T1-c 的落点相应变更，见 §2.3 的更新说明。**

### 8.3 逐条核实通过（行号与描述均属实）

| 条目 | 核实要点 |
|---|---|
| A3 | `useShortcutRegistrations.ts:192-206` 三个 register；`settings.rs:1053-1079` 默认 35 条不含它们；`ShortcutsSection.tsx:92` 渲染源确为 `Object.entries(value.bindings)`；`:194,199,204` 三个硬编码英文 label 属实。**补充**：这三条经 CommandPalette 仍可执行（`CommandPalette.tsx:127`），不可达的只是绑定 |
| A4 | `ShortcutsSection.tsx:70-74` 属实 |
| A5 | 全文 118 行属实；无 reset/filter/解绑属实；`:90` 单搜索锚点属实；默认 35 条中 18 条数字项属实（`settings.rs:1073-1078`） |
| A6 | `useShortcutsStore.ts:16-24` 七条清单、`:150-152` 与 `:178-180` 两处放行、`:7-14` 七条注释理由，全部属实。**补充**：`command-palette` 自己也在清单里，而它是所有被屏蔽动作的唯一备用入口（`CommandPalette.tsx:127-129` 列出动作，`COMMAND_PALETTE_TOGGLE_EVENT` 唯一 dispatcher 是那个快捷键） |
| A8 | `FeatureTips.tsx:180-191` / `:77` / `:110-117` 属实；`TipsSettings`（`web/types/settings.ts:161-168`）确无用量字段；`:78` 候选耗尽即 `return null` 无轮换属实；docs/58 §3.3 原文属实。**补充实测**：dev 实例 `sessionCount=131` 仅弹过 1 条、`tried` 为空 |
| A10 | `featureTipRegistry.tsx:104` 用 `motion-safe:animate-pulse` 属实；`motion-reduce:animate-none` 合规属实；docs/46 §6.1 原文属实；仓库 token 用法（`ShortcutsSection.tsx:102` 的 `var(--dur-fast)`）属实 |
| B4 | `OnboardingGuide.tsx:449` `onOpenChange` 在非 busy 时调 `complete()` 属实 |

### 8.4 B3 的复核结论

**B3 · `sessionCount` 语义 —— 复核后不构成缺陷，但有两点偏差，不排期。**

`FeatureTips.tsx:110-117` 的结构属实。逐路径分析：

- **多计**：不会。`sessionCountRecorded` 是模块级变量（`:19`），在 `await` 之前就置 true（`:112`），
  React 19 严格模式的双挂载不会重复计数。
- **漏计**：会，但方向与原推测相反。`persistTips` 失败时 `:114` 把 flag 复位，
  而 effect 的依赖是 `[persistTips, tipsSettings]`——`persistTips` 是空依赖的 `useCallback`（稳定），
  `tipsSettings` 在保存失败时通常不变，所以**effect 不会重跑**。
  复位的 flag 等不到重试机会，这一次启动的计数**静默丢失**。
  原推测的「可能重试计数」（多计）不成立，实际是**失败即少计一次**。
- **语义**：`sessionCount` 计的是**应用启动次数**，不是终端会话数或 agent 会话数。
  它唯一的消费点是 `checkFeatureTipTiming:50` 的 `sessionCount <= 3`（新用户前三次启动不打扰），
  在这个用途下「启动次数」是合理读法，与 docs/58 §3.3 的「X 个会话」不冲突
  （§3.3 那句真正缺的是**用量计数**，已单列为 §3.3 / T3-a）。

结论：**不排期**。漏计一次不影响任何行为（阈值是 3，且失败是异常路径）；
真正要补的是用量计数，已在 §3.3。若 T3-a 落地时顺手把这个 effect 的重试补上，可以，但不是必须。

### 8.5 B4 的处置：作为待决策点如实呈现，不判为 bug

`OnboardingGuide.tsx:449`：

```tsx
onOpenChange={(nextOpen) => { if (!nextOpen && !busy) void complete(); }}
```

误触 Esc 会把 `onboardingCompleted` 永久置 true。**但这正是 docs/46 §6.1 要求的**：

> 关闭、Esc 与「跳过全部」必须收敛到同一持久化语义。

且设置里有重跑入口。所以两面都成立：

- **判它是缺陷的一面**：Esc 是最容易误触的键，代价是永久跳过首启引导。
  新用户误触的概率不低，而他恰好是最需要引导的那个人。
- **判它不是缺陷的一面**：风格宪法明文要求三条退出路径语义收敛；
  分出「Esc 只关不完成」就是在制造两种退出语义，反而违宪；且有重跑入口，损失可恢复。

**需要产品决策，本文不替它拍板。** 若要在不违反 §6.1 的前提下降低误触代价，
一个不改变持久化语义的方向是：`complete()` 后给一条带「重新打开引导」动作的 toast——
语义仍然收敛（都完成了），只是把重跑入口从设置深处提到了当下。这只是一个候选，不是结论。
