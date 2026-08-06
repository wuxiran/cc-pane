# 78 · Tab 生命周期与终端恢复统一重构总纲

> 重构总纲：生命周期抽取（四批）+ 恢复路径归一（checkpoint+delta）+ daemon 边界契约，合计五批。
> 按项目纪律：方向文档不整体预审，**实施时逐批抽 plan + codex 交叉评审**；每批独立发版、独立回滚。
> 实施从 0.11.11+ 开始，不与 merge/0.11.10 发版叠加。

## 0. 症状：为什么是重构，不是再打一个补丁

近期事故链（0.11.7→0.11.9）复盘出的共同形态：3.8GB 渲染进程卡死 → 补休眠；daemon 无界广播 → 补 desync 契约；溢出截断提示不可恢复 → 补自动 snapshot 重放。**每个补丁都要往 `TerminalView.tsx` 的无依赖每帧 effect 里塞一行，每次都要再拆文件才能过行数棘轮**——代码已经在报警。

两轮全量探索（分支 merge/0.11.10）确认，有三件事从未被声明过：

### 0.1 「一个 tab 的生命周期是什么」没有答案

- 7 个互相耦合的裸可选字段（`restoring`/`savedSessionId`/`restoreBlockedReason`/`leaseReadOnly`/`launchError`/`launchAttempt`/`disconnected`）描述生命周期，合法组合靠各消费方脑补；
- `Tab` 与 `TerminalPaneLeaf` 约 20 个字段双写，靠手抄的 `syncTabTerminalState`（`usePanesStore.ts:212`）同步，每加一个字段都要记得补；`launchId`/`restoreMode` 是 leaf-only，tab 层拿不到；
- **terminal 是 7 种 contentType 里唯一有生命周期的**：browser 只有 setVisible + React unmount 兜底，editor/file-explorer/mcp-config/skill-manager/memory-manager 连 `isVisible` prop 都收不到。

### 0.2 「谁负责收尸」没有答案

创建侧 **19 个入口、三套构造**（`createTab` 工厂 / 6 处内联字面量 / `paneTreeHelpers.ts:41` 遗留同名工厂）；销毁侧 **7 个出口，store 全部不管回收**——杀会话有 **5 份独立实现**（`useTabClosing` / `Panel.tsx` 分屏格 / `LayoutDeleteDialog`（唯一有确认+detach）/ `backgroundLayoutRestore` 反向 kill / 孤儿对账 GC）。已确认的泄漏路径：

- `closePane` 关含分屏的 pane 只杀活跃 leaf，其余 PTY 成孤儿；
- 非对话框路径调 `deleteLayout` 整层泄漏；
- `applyLayoutSnapshotPayload` 整树替换，旧树全部会话无人杀（最大批量泄漏）；
- `closeEditorTabsByPath` 跨布局直接 splice，绕过一切语义；
- 附属状态四类无人清：`poppedOutTabs` Set、`fullscreenTabId`、`useTerminalStatusStore`/`useContextUsageStore` 条目、`closedTabs` 无上限。

`useOrphanSessionReconciler`（每 10 分钟对账 GC）的存在本身就是缺销毁钩子的自白。

### 0.3 「可见是什么意思」没有答案

至少 **6 种口径**：Panel 一次算出三 props（`isVisible` 已含 layoutVisible，`layoutActive` 冗余）；TerminalView 拆成三个 ref + `isRenderVisible()` + `shouldRunWebglRecovery()` + 直接读 props 的第三种组合；BrowserTabContent 第四套（`isVisible && !webviewBlocked`）；layoutScheduler 自带 isActive + 每调用点 `allowInactive` 逃生阀；**弹窗终端硬编码 `isActive=true` 永远自认可见**（积压/降档/休眠全盲区）；**星标镜像三字段填同值**（白跑一整套降档，且同一 PTY 两个 "active" 视图）。flush 时序竞态被两个模块各防一次——因为没有单一可见性事件源。

**共同根因：生命周期知识长在组件树里，而资源（PTY/webview/定时器/store 条目）的生死不应依赖组件是否在场。**

## 1. Orca 对照（MIT 开源 stablyai/orca，读源码结论）

对标品 Orca（3.5 万星）与我们在两个核心决策上**独立收敛到相同答案**，另有两处真差距：

### 1.1 相同的决定（路线被同行验证）

- **PTY 活在 app 外的独立 daemon 进程**：Orca 的 `daemon-main.ts`（Unix socket + token + pid/startedAt/launchNonce 身份三元组）与我们的 daemon-manifest + `discovery.rs` 分级核验几乎同构。"daemon 模式可不可行"有了业界对照答案：可行且必需。我们还多一层它没有的能力——daemon 多客户端共享（桌面+web+手机）。
- **生命周期集中抽取**：`pane-manager/pane-lifecycle.ts` + `use-terminal-pane-lifecycle.ts` hook + store slice 集中状态，与本文三层模型同构。

### 1.2 它好在哪：一条恢复规则

Orca 的概念只有一条：**模型是唯一真相，视图是可抛弃投影**。切后台=扔投影、切回=重投影、崩溃=重投影、重连=重投影——一条恢复路径处处适用。我们的对应物是五个补丁的堆叠（512KB 隐藏积压、溢出转快照、desync 契约、休眠序列化、8MB 字节环重放），各有各的触发条件与恢复路径。**本重构的目标不是抄它的结构，是抄它的简单性。**

### 1.3 不抄什么：headless 双胞胎

Orca 在 Electron 主进程跑 `@xterm/headless` 孪生终端实时消化每字节（`headless-emulator.ts`）。不抄，两个理由：①每字节解析两遍 + 一整族正确性难题（查询应答权、Unicode 宽度一致、断尾转义），它为此写了几十个文件；②它两侧是**同一个模拟器**（都是 xterm）所以对得上账，我们 daemon 是 Rust，只能上异卵双胞胎（`alacritty_terminal` 类），跨实现一致性是永久税，且解析后网格模型每会话 ~50MB——刚从 renderer 赶走的内存搬进 daemon 还膨胀 6 倍。

### 1.4 抄什么：checkpoint+delta（它已生产验证）

Orca daemon 的耐久层落盘结构（`daemon-checkpoint-file.ts`）：

```
checkpoint.json = { snapshotAnsi(序列化画面) + scrollbackAnsi(历史)
                  + rehydrateSequences(模式重建) + modes + generation }
+ output.log     = 同 generation 的增量字节流水
```

即「**照片 + 照片之后的流水**」，generation 配对防旧照片配新流水。恢复 = 回放照片 + 追加流水：快（不从头算）、准（照片是模型原样）、不限历史深度。**它证明了这层不需要 headless twin 也能做**——照片谁拍的不重要，我们用 xterm 的 SerializeAddon（休眠已在用）拍即可。这就是批 3 的方案（§4.3）。

另抄三个细节：**输入归段**（`agent-hibernation-input-guard.ts`：最后输入归到所落的 agent 状态段，working 段=草稿阻止休眠，waiting/blocked 段=已提交回答不阻止——解决"答过一次权限确认就永不休眠"，比冷却窗口精准）；**可见性带时间戳**（`foregroundLastSeenAt` 进快照）；**隐藏零投递闸门**（`pty-hidden-delivery-gate.ts`：无可见视图的 PTY 字节源头断流，reveal 走快照重建；drop 标记只由 unhide 消费、预留 delivery-interest 豁免位）。

## 2. 目标模型

### 2.1 对外 API：`useTabLifecycle` 钩子

我们的 tab 是 display:none keep-alive 形态，React 原生 mount/unmount 感知不到"切走/切回"——这正是六种可见性口径的根源。对外接口按 Vue keep-alive（activated/deactivated）/ 小程序 Page（onShow/onHide）的形态设计：

```ts
useTabLifecycle(tabId, {
  onShow / onHide,            // 任一视图 隐↔显（聚合：任一视图可见即 show）
  onActive / onInactive,      // 焦点得失
  onBackground,               // 后台满 5min（降档点）
  onHibernate / onWake,       // 后台满 30min 休眠 / 唤醒
  onBeforeClose,              // 可否决：返回 CloseGuard[]
  onClosed,                   // 资源回收（不可否决）
  // 领域钩子：
  onUserInputActive / onUserInputIdle,  // 轴1；休眠豁免/打扰闸门/IME 保护
  onSessionStateChanged,                // 轴2 跃迁；确认判据/徽章/通知
  onPersist / onRestoreState,           // 快照存取，恢复能力推广到全部 7 种（批4）
  onAttention,                          // 后台 tab 请求注意（红点），批 2 附带
});
useTabVisibility(tabId): "active" | "visible" | "hidden"
```

**刻意不加**：`onBeforeHibernate` 否决钩子（不给组件否决休眠的权力，正当理由已由输入豁免覆盖）；`onResize`（layoutScheduler 内务）；`onOutputActivity`（属 fleet/会话监控，docs/64 范围）。

**双轨纪律**：`onClosed` 的回收不能只靠钩子——钩子依赖组件挂载过，而快照覆盖/后台布局删除时组件从未挂载（正是现在泄漏的死因）。登记表的静态回收函数是兜底真相，钩子是其上的组件级便捷层，两者由同一条销毁管线驱动：组件在场走钩子，不在场走登记表。

### 2.2 三轴模型

每个 tab 的行为由三条独立轴组合决定，每种 contentType 在登记表里声明每条轴的信号源（可为空）：

| 轴 | 含义 | terminal(agent) | terminal(shell) | editor | browser | 其余 4 种 |
|---|---|---|---|---|---|---|
| **1 用户输入活跃** | 人的手在不在 | onData 键盘（**输入归段**判定） | 同左 | 打字 | 表单/滚动 | 表单 |
| **2 内容忙碌** | 有没有事在进行 | busy/waitingInput（OSC/hook） | **无此轴**（状态是 none 不是 idle，勿混淆） | dirty（现存确认即本轴实例） | 下载/播放（v1 不判） | 无 |
| **3 后端资源** | 关了要收什么尸 | PTY（分屏全量） | PTY | 无 | webview 进程 | 无 |

关闭确认矩阵（用户拍板）：agent 忙→弹确认（对齐 LayoutDeleteDialog 体验）；agent 闲→直接关；纯 shell→直接关（"子进程存活确认"记遗留不实施）；editor dirty→弹（现状保持）；browser v1 不拦。后端驱动关闭与快照覆盖**跳过确认但绝不跳过回收**。

### 2.3 三层实现（钩子之下）

| 层 | 放什么 | 载体 | 理由 |
|---|---|---|---|
| 状态层 | 生命周期阶段 + 每视图可见性快照 | Zustand | 可订阅可持久化；组件在不在场都在 |
| 登记表 | 每 contentType 的资源清点/守卫/回收/构造默认值 | `web/lib/tabLifecycle/` 纯数据+纯函数，穷举登记+穷举测试（仿 `lib/tabContentType.ts`） | 回收只依赖 tab 数据 |
| 视图控制器 | xterm 实例、定时器等命令式资源 | 模块级 Map（仿 `terminalBackgroundLifecycle.ts` 工厂形态：回调注入+dispose+幂等） | 不可序列化，只管视图自己 |

**可见性的键 = (tabId, role)**，role ∈ primary/mirror/popup。聚合语义（用户拍板）：**任一视图可见就不降档不休眠**（弹窗开着的会话不休眠）；渲染/WebGL 看单视图；mirror 视图不注册降档。

**不做事件总线**：Ctrl+W 的 window 事件广播 + N 个 Panel 竞相自查正是要消灭的形态。"事件" = 销毁管线阶段名 + store 状态跃迁，发射点集中。

### 2.4 扩展性契约

加一个新钩子只碰 `tabLifecycle/` 目录三处（interface 加可选成员 / 信号源接线 / 发射点一行），目录外零改动；守卫测试穷举断言每个钩子名在 dispatch 表有发射点。落地时以 `onAttention` 为例把"加新钩子"流程走一遍作为示范。**验收标准：未来任何新生命周期机制的 PR 若 touch 了 tabLifecycle/ 之外的可见性/关闭逻辑，即视为架构回退。**

## 3. daemon 边界契约（横切纪律，随批 3 落地）

daemon 架构本身从未出过问题，出问题的全是**边界**：resume id 掉进 `ws_emitter.rs` 的 `_ => {}`（docs/45）、scrollback 停产、notifier 事件整族静默丢失——同一种病：跨进程要传哪些事件从未被当成契约枚举，漏一个补一个，死得无声。

治法与登记表同一个思想：**跨 daemon 事件总表 + 双侧穷举测试**。表列全部跨界事件（output/exit/killed/desync/resume-id-detected/notifier/launch-warning/claim-lost/hidden-mark(批3新增)/checkpoint(批3新增)），每行声明：方向、通道（per-session WS / control）、丢失语义（可丢/留存补拉/control 兜底/必达）、旧版兼容行为。测试两侧各一份：daemon 侧断言 emitter 对表中每个事件有非默认分支；app 侧断言 `DaemonStreamMessage`/control 分发对每个事件有 handler——**让 `_ => {}` 吞掉新事件在 CI 就报错**。新增跨界事件必须先改表。

## 4. 五批 roadmap

依赖链：批1 →（removeView 依赖出口）批2 →（闸门与 checkpoint 消费 aggregate）批3；批4 随时可并行；批5 依赖批1-4 稳定后评估。迁移纪律（用户拍板"平缓、一点点迁移"，绞杀者模式）：**新层先立、旧路后拆；每迁一个消费者一个 commit；高危处并行双写 + dev 断言一致跑一个发版周期再删旧路。** 每批完成后 CLAUDE.md Known Gotchas 增补对应条目（登记表/契约表的存在需要被后来者发现）。

### 批 1 · 销毁统一出口（0.11.11，最痛先治；docs/68 §2.1 + T1-c 顺带落地）

新建：
- `web/lib/tabLifecycle/registry.ts` + 穷举测试：
  ```ts
  interface TabLifecycleEntry {
    collectResources(tab: Tab): TabResources;          // { sessionIds, browserTabIds, poppedOut }
    closeGuards(tab: Tab, ctx: GuardContext): CloseGuard[];  // [] = 放行
    onClosed(tab: Tab, opts: { detach: boolean }): void;
  }
  export const TAB_LIFECYCLE: Record<TabContentType, TabLifecycleEntry>;
  ```
  terminal：collectResources 复用 `lib/paneSessions.ts` 的 `collectTerminalSessionIds`（分屏全量）；closeGuards 读 `useTerminalStatusStore` busy/waitingInput；onClosed = kill 全量 + detach 选项（收编 LayoutDeleteDialog 语义）+ 清 status/contextUsage 条目。browser：onClosed 收编 webview close（不再靠 React unmount 兜底）。editor：closeGuards 承接 dirty。其余四种显式登记 no-op。
- `web/lib/tabLifecycle/destroyPipeline.ts` + 测试：
  ```ts
  type DestroyReason = "user-close" | "batch-close" | "close-pane" | "delete-layout"
                     | "snapshot-apply" | "backend-close" | "editor-path-close";
  planTabDestroy(tabs: Tab[], reason: DestroyReason): DestroyPlan;  // 纯函数：收集+聚合 guards
  commitTabDestroy(plan: DestroyPlan): void;                        // 回收 → 树操作 → 附属清理
  ```
  snapshot-apply/backend-close 不可否决但必回收（矩阵单测锁死）。

改动：`usePanesStore.ts` 新增唯一内部出口 `removeTabsInternal(tabIds, reason)`（树操作 + poppedOutTabs/fullscreenTabId 清理 + closedTabs 上限 20），7 个出口（closeTab/closePane/closeTabsToLeft-Right-Other/deleteLayout/applyLayoutSnapshotPayload/`closeTabBySessionId`(:2459)/closeEditorTabsByPath）全部改道，任何出口不再自带杀会话；`useTabClosing.ts` 改薄（plan → 确认弹窗（列会话状态，对齐 LayoutDeleteDialog）→ commit）；`Panel.tsx` 分屏格关闭与 `LayoutDeleteDialog.tsx` 杀会话逻辑迁入 registry；TabBar 右键/命令面板接 `reopenClosedTab` 撤销（T1-c）。

测试：registry 穷举（每种 contentType 必须登记）；每 DestroyReason × 每泄漏路径断言 **killSession 调用集合精确相等**（多杀少杀都挂）；poppedOut/fullscreen 清理断言。手工验收：busy 会话三种关法（× / Ctrl+W / 右键批量）均弹确认、空闲终端与纯 shell 不弹、撤销恢复带原 resumeId。
风险：把漏杀修成多杀——detach 显式参数、poppedOut 判定进 collectResources；自动化路径误挂 guard 卡死无人值守流程——可否决矩阵单测锁死。
验收仪表：孤儿对账 GC 发现数趋零（加计数日志）。回滚：每出口一 commit，逐出口回退。

### 批 2 · 可见性单源

新建 `web/stores/useTabViewStateStore.ts`（独立轻 store，高频写入不触发布局树订阅者）：

```ts
type ViewRole = "primary" | "mirror" | "popup";
type ViewVisibility = "active" | "visible" | "hidden";
views: Record<`${tabId}:${role}`, { role, visibility }>;
aggregate: Record<tabId, { anyVisible; anyActive; foregroundLastSeenAt }>;  // 写入时维护，非 selector 派生
reportView(tabId, role, visibility);  // 写前 diff，同值不触发
removeView(tabId, role);              // 批1 的 removeTabsInternal 也调
```

写入方：Panel（三 props 归一为单枚举）、弹窗（真实 `document.visibilityState` + focus，修盲区）、镜像（role=mirror）。消费方逐个迁移：TerminalView 三 ref / isRenderVisible / shouldRunWebglRecovery / props 直读版全部改订阅（降档/休眠/积压消费 `aggregate.anyVisible`，渲染/WebGL 消费单视图）；每帧 effect 瘦身，flush 竞态在订阅回调内按固定顺序声明式解决；scheduler 改读 store（allowInactive 标记 deprecated 逐个复核）；五种无可见性的 contentType 组件自行按 tabId 订阅（传递链断裂自然消失）。轴 1 输入归段同批落（`useTerminalStatusStore` 补 stateHistory 段记录 + 每 pane 的 `lastInputAt` 时间戳——归段判定的两个输入缺一不可）；`onAttention` 同批附带（发射点：会话完成/出错/等输入且 `aggregate.anyVisible=false`）。

风险最高在 TerminalView（docs/71 三条不变式不许破）：**并行双写 + dev 断言一致跑一个发版周期，零漂移再删旧 ref**，本批拆两个子发版。React 19 dev 双挂载：reportView/removeView 幂等。
验收仪表：TerminalView 可见性 ref 数 3→0；双写断言零不一致。

### 批 3 · 恢复归一：checkpoint+delta + 隐藏零投递闸门（daemon 侧主战场）

目标：把五条恢复路径（休眠唤醒/desync 重放/溢出恢复/崩溃恢复/重连回放）合并成一条「**取照片 + 补流水**」，同时后台标签源头断流。

- **checkpoint 存储**：daemon 每会话存 `{ generation, snapshotAnsi, bufferMode, cols/rows, checkpointedAt }`（`bufferMode` 对齐现有 `TerminalReplaySnapshot { data, bufferMode }` 契约——alt-screen 剥离链路依赖它，docs/73）+ 该 generation 之后的 delta 字节（ReplayBuffer 改造为 checkpoint 锚定：有 checkpoint 时只保 checkpoint 之后的字节，8MB 窗口从"会话起点"变"上一张照片起"——历史深度不再受限）。落盘复用 `session_output_store` 机制。
- **拍照时机**（前端 serialize → 上传 daemon，走新 IPC/REST + control 消息，进 §3 契约表）：休眠 Tier2 时（照片已在拍，多存一份）；隐藏满 N 分钟边沿；delta 超阈值（如 4MB）时由 daemon 请求前端补拍。generation 配对防旧照片配新流水（Orca 同款）。
- **隐藏零投递闸门（按订阅连接记账，不是按会话）**：daemon 是多客户端共享的（§1.1 相对 Orca 的优势），桌面把标签切后台**不得掐断手机/web 端正在看的同一会话**——hidden 标记必须挂在**每个订阅连接**上。恰好 `ws_emitter` 的 per-subscriber 结构（0.11.9 的 desynced 标志已是每连接一份）就是正确挂载层：各客户端经自己的 control 连接上报 hidden 集合，daemon 只对该连接跳过投递（delta 照常累积），置该连接的 droppedWhileHidden；unhide 时向该连接发既有 `{"type":"desync"}`，前端走现有 `resyncFromReplaySnapshot`——重放机制零新增。抄全 Orca 两细节：drop 标记只由 unhide 消费（hidden 重标记不清除）；预留 delivery-interest 豁免位。**范围注**：闸门仅 daemon 模式生效；in-process 模式无 WS 段，后台节流仍由前端 512KB 积压承担。
- **恢复统一**：`get_terminal_replay_snapshot` 返回 checkpoint+delta 拼接结果，前端五条路径全走它；512KB 隐藏积压保留为"短隐藏免重放"的快路径，溢出即作废改走统一恢复（0.11.9 已是此语义）。
- **daemon 边界契约表 + 双侧穷举测试**（§3）随本批落地（本批新增两个跨界消息，正好首用）。

测试：generation 错配拒绝回放；hidden 期间 delta 连续性；unhide 必发 desync；断线重连走同一路径；旧 app 对新消息静默忽略（`Unknown` 兜底回归）。
风险：拍照上传的 IPC 体积（1-4MB 偶发，本地零成本，但节流防抖要有）；两侧 generation 状态机需幂等。
验收仪表：后台标签 WS 流量归零；恢复路径实现数 5→1；desync 重放从"近似"变"精确"（重放后画面与休眠序列化逐字节一致的用例）。
收益兜底：即使 checkpoint 部分延期，零投递闸门 + desync 单独成立（复用 0.11.9 机制），本批可再拆两个子发版。

> **0.12.0 实施记录（批3 裁剪）**：本批只落地 M3a（契约表 + 隐藏零投递闸门的
> daemon 侧），M3b（checkpoint+delta）顺延。理由是探索阶段发现三条本文未写的
> 约束：①`generation` 名字已被 `daemon_generation`（进程 started_at，用于认领
> 判定）占用，语义完全不同，必须改名；②checkpoint 锚定会打断轮询降级路径的
> 增量算法——`replay_snapshot_delta` 依赖快照「前缀增长」用 `strip_prefix` 取
> 增量，失配分支是**整屏重发**，而那条路径没有测试；③前端 serialize 产物目前
> 只存内存，上传 daemon 是全新链路，与 control 上行改造同批风险叠乘。
>
> 已落地：`cc-panes-core/src/services/boundary_events.rs` 契约表 + emitter 穷举
> 守卫（让 `_ => {}` 吞新事件在 CI 报错）、`web/services/daemonEventContract.ts`
> 镜像表 + 三处分发覆盖断言、daemon 侧 hidden 闸门（按连接记账、只掐可丢输出、
> 断线清标记）。
>
> **已接线（补账1，0.12.0 收尾期）**：两块缺口均补齐——①关联协议复用既有
> instanceId（per-session WS 的 WsQuery 本就带它，control URL 补上同一个，
> 同源即关联）；②control link 改双向（watch 通道承载 hidden 全集，重连补发
> 最新值）+ `set_hidden_terminal_sessions` command + 前端 useHiddenSessionReporter
> （订阅聚合、去抖 800ms、纯函数派生带 5 测试）。**上报不保证生效**（旧
> daemon 丢弃/断线/web 模式无 control），前端 512KB 积压是永久兜底。
> 生效前提：daemon 二进制已更新且已重启（binaries 陈旧 gotcha）。

### 批 4 · 创建收敛（可与批 2/3 并行）

registry 补 `createDefaults(input): Partial<Tab>`；`usePanesStore.createTab` 成唯一构造点，6 处内联字面量改道（**逐处 diff，不顺手统一**——字面量里可能有故意差异），删 `paneTreeHelpers.ts:41` 遗留工厂；修 `useOrchestratorListener.ts` 把 projectId 复用当 launchId 的 bug（docs/69 暗雷活体：launch id 必须每次新生成）；`ClosedTabSnapshot` 扩容（starred/pinned/parentTabId/launchExtras/分屏结构，以 `cloneTerminalLeaf` 的重置清单为准）让撤销真正无损；`canCreateTerminalSession` 6 处守卫收进模块级 `acquireTerminalSlot()`（防重入状态从组件 ref 移出）；三处 PTY spawn 本体**不合并**。`onPersist/onRestoreState` 推广同批：browser 存 URL+滚动、editor 存 filePath+光标。
测试：工厂输出与原字面量逐字段快照相等；ClosedTabSnapshot 往返全等；launchId 唯一性。验收仪表：内联构造点 grep 归零。

### 批 5 · Tab/leaf 双写收敛 + 判别联合（先评估再动）

判据：批 1-4 观察期内 `syncTabTerminalState` 相关 bug 数与被迫双写次数，接近零则**降级为只做判别联合**（`TerminalRuntimePhase`: idle/launching/restoring/restore-blocked/running/disconnected/exited——非法组合类型层不可表达，独立有价值）。若做全量：leaf 为终端运行时单一真相、删 syncTabTerminalState；持久化版本号 + 单向迁移 + 旧格式读入测试；恢复链路全量手工回归（18-tab 重启恢复为既有事故复现用例）。全项目最高风险，独占一批灰度发版。

## 5. 明确不做

1. Panel 常驻挂载不动（display:none 保留；React 卸载对 xterm 是灾难，休眠+checkpoint 已覆盖内存与恢复诉求）；
2. headless 双胞胎不做（§1.3，跨实现一致性永久税 + 内存搬家膨胀）；
3. 事件总线不做；
4. 布局双份真相（rootPane 工作副本 vs layouts[]）与 eachLayoutTree 的 starred 语义分裂不动（除非批 5 顺手零风险）；
5. 三处 PTY spawn 本体不合并；
6. pinned 前端语义不改（backend 强制忽略改为 DestroyReason 矩阵显式声明）；
7. 本重构期间不扩 contentType。

## 6. 遗留（记录不实施）

- **Tier3 进程级休眠**：done 且可 resume 的 agent 直接杀 PTY、靠 provider resume 复活（省 daemon 侧整机内存；Orca 的 hibernation 即此，为它写了 planner/coordinator/input-guard/confirmation 四件套且默认关）。原料全齐（resumeId 捕获链 + launch_history + restore 队列），等批 3 稳定后单独立项。
- 纯 shell 的"子进程存活"关闭确认（`get_resource_tree` 可判但会误伤 vim 类场景）。
- browser webview 休眠（无重放兜底、表单真丢；启用时必须配轴 1 豁免）。
- editor 双数据源（useEditorTabsStore vs pane 树）合流；`useEditorTabsStore` 侧 dirty 无确认路径。

## 7. 与其他文档的关系

- **docs/68**：§2.1 关闭确认与 T1-c 撤销接线由批 1 吸收，对应条目落点迁移至此。
- **docs/71**：输出链现状（休眠/desync/流控）是本文批 3 的地基；三条不变式（丢弃整段/回放过 renderTerminalData/唤醒不丢字）全程有效。
- **docs/64**（fleet）：会话监控维度不混入 tab 生命周期；`onOutputActivity` 归它。
- **docs/74**（开发台账）：任务生命周期与 tab 生命周期是两个正交模型，互不吸收。

## 7.5 M3b 实施记录（0.12.0 收官期）

> 批3 顺延的 M3b 已全量落地（六子批，设计与评审吸收见
> `.claude/plan-m3b-design.md`，按 plan-lands-in-docs 纪律择要并入本节）：
> **M3b-0** 轮询失配→desync（两份实现测试互指）；**M3b-1** ReplayBuffer
> checkpoint 槽 + epoch/seq 记账（五态拒收 + seeded 重组测试）；**M3b-2**
> REST 上传端点（16MB body limit + ensure_may_write）+ seq 四层贯通
> （TerminalOutput.endSeq）+ 补拍扫描（30s/4MB/60s 节流）+ 前端三触发点
> （休眠 Tier2 / 隐藏 5min 边沿 / daemon 补拍）+ capability 关断；**M3b-3**
> recovery-snapshot 读端点 + 前端读路径 5→1（photo 直写/delta 过渲染双管道，
> epoch 激活上传）；**M3b-4** 锚定裁剪开启（旧端点返回 photo+delta 拼接串
> 保画面完整）；**M3b-5** checkpoint 落盘（只写不读）。
>
> 关键裁决与评审修订：anchorSeq 活在 daemon raw seq 空间（锚点只认 chunk
> endSeq + onWritten 确认 + 无 in-flight）；checkpoint_epoch 独立于
> daemon_generation（第四拒收态）；恢复响应结构化不预拼接；回退语义诚实
> 降级；render_flavor 删除。遗留：checkpoint.json 冷恢复读回（§6）。

## 8. 清理待办（rebase + 双写拆除专题之后执行）

> **已全部完成（0.12.0 收官期，P1 双写拆除 + P2 结构四件）**：双写拆除删净
> 旧可见性 props 链与六个散装销毁出口（P1-1..P1-6）；四件结构清理落地为
> P2-1（lib/paneTree 搬家）、P2-2（splice 收敛/sizes 归一/含星标遍历去重，
> a、b 两对已随旧出口删除消失）、P2-3（closedTabsUndo 改名）、P2-4
> （removeTabsInternal 三段拆分）。尾注三项仍为待办。原文留档：

1. **纯树函数搬 `lib/paneTree.ts`**：collectPanels/findPane/findTabLocation/
   normalizePaneTree 等零 store 依赖的纯函数现住 `stores/paneTreeHelpers.ts`，
   导致 `lib/paneSessions → stores/` 的层次倒置；搬完即可合并
   paneTreeRemovalHelpers 回去、删「只依赖 @/types」口头约定。
2. **4 处收壳/收敛复制去重**：closePane↔removeEmptyPane 约 40 行逐字相同；
   closeTerminalPane↔closeTerminalLeafInTab 内联复制；removeTabsInternal 与
   backendCloseActions 的逐布局变体。单方向抽函数，行为零变化。
3. **`closedTabsCap.ts` 改名 `closedTabsUndo.ts`**：四职责 = 撤销栈完整生命
   周期（cap/快照映射/身份恢复/非终端重开），名字只描述了第一个。
4. **`removeTabsInternal` 拆段**：118 行 8 步平铺，抽 relocateAndCollect /
   spliceAcrossLayouts / cleanupSatelliteState 三个命名私有函数。

另записан：exitCode→leaf 写回（让 phaseOf 的 "exited" 真可达）、非终端撤销的
pinned/starred 保留、useHiddenSessionReporter 订阅面收窄（当前判定可接受）。
