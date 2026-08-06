# 0.12.0 批1 · 并行轨 worker 任务书

分支：`feat/0120-tab-lifecycle`（已拉好，首 commit `475020e` = docs/78）
Plan：`C:\Users\wuxiran\.claude\plans\0-12-0-resilient-journal.md`（已过 Codex 评审）
总纲：`docs/78-tab-lifecycle-and-recovery-rework.md`

## 全轨共同纪律

1. **只写文件，不跑 git**。不 `git add`、不 `git commit`、不切分支。leader 逐轨验收后统一提交。
2. **严禁 `git add -A`**（仓库根有大量垃圾 untracked 文件）——你根本不该碰 git。
3. **不跑测试**（worker 过程中禁跑，leader 收尾统一跑）。写完自查语法即可。
4. 只碰自己轨的文件清单，**碰到清单外的文件先停下来问 leader**。
5. 新文件 ≤500 行（行数棘轮 `web/test/lineRatchet.test.ts`，新文件默认上限 500）。
6. 完成后调 `report_to_leader(workerId, status="completed", summary="...")`。

## 轨 A · registry.ts + destroyPipeline.ts（B1-01 + B1-02）

**文件（全新，无冲突）**：
- `web/lib/tabLifecycle/registry.ts` + `registry.test.ts`
- `web/lib/tabLifecycle/destroyPipeline.ts` + `destroyPipeline.test.ts`

**registry.ts**：

```ts
interface TabResources { sessionIds: string[]; poppedOutTabIds: string[] }
type CloseGuard =
  | { kind: "agent-busy"; tabId: string; tabTitle: string; sessionId: string; status: TerminalStatusType }
  | { kind: "editor-dirty"; tabId: string; tabTitle: string };
interface GuardContext {
  statusOf(sessionId: string): TerminalStatusType | null;   // 注入，不直读 store（可测）
  isPoppedOut(tabId: string): boolean;
}
interface TabLifecycleEntry {
  collectResources(tab: Tab, ctx: GuardContext): TabResources;
  closeGuards(tab: Tab, ctx: GuardContext): CloseGuard[];
  onClosed(tab: Tab, opts: { detach: boolean; reason: DestroyReason }): void;
}
export const TAB_LIFECYCLE: Record<TabContentType, TabLifecycleEntry>;  // 7 种全登记
```

要点：
- **本轮 closeGuards 只承接现状语义**（editor 的 `tab.dirty`）。**terminal 的 agent-busy guard 本轮返回空数组**，留 B1-06 打开——绞杀者纪律：先等价迁移，再增强。CloseGuard 类型里的 `agent-busy` 分支现在就定义好。
- terminal.collectResources 用轨 C 新增的 `collectTerminalSessionIdsWithSaved(tab)`（**并入 savedSessionId**）。轨 C 可能还没写完，你先按签名调用，import 报错先留着并在报告里说明。
- terminal.onClosed 顺序固定：detach（`detachOutput`+`detachExit`）→ `killSession(id, reason 映射值)` → `useTerminalStatusStore.removeSession(id)` → contextUsage 命中则 `setSession(null)`。**注意 useContextUsageStore 是单例 store 不是 Record**（`web/stores/useContextUsageStore.ts:5-13`），"清理"= `getState().sessionId === 被关 id` 时 `setSession(null)`。
- browser.onClosed 收编 webview 关闭；其余四种（file-explorer/mcp-config/skill-manager/memory-manager）显式登记 no-op。
- **不要在本轨调用 killSession 的真实实现**——onClosed 里通过依赖注入或直接 import terminalService 均可，但要让测试能 mock。

**destroyPipeline.ts**：

```ts
type DestroyReason = "user-close"|"batch-close"|"close-pane"|"delete-layout"
                   |"snapshot-apply"|"backend-close"|"editor-path-close";
export const DESTROY_POLICY: Record<DestroyReason, {
  vetoable: boolean; recordsClosedTabs: boolean; respectsPinned: boolean;
  kills: boolean; closesPopups: boolean;
}>;
export const DESTROY_KILL_REASON: Record<DestroyReason, KillReason | null>;
export function planTabDestroy(tabs, reason, ctx): DestroyPlan;   // 纯函数
export async function commitResourceDestroy(tabs, reason, opts: { protectSessionIds?: ReadonlySet<string> }): Promise<void>;
```

矩阵取值（**逐格照抄，不要自己推**）：

| reason | vetoable | closedTabs | respectsPinned | kills | KillReason | closesPopups |
|---|---|---|---|---|---|---|
| user-close | 是 | 是 | 是 | 是 | user-close | 是 |
| batch-close | 是 | 是 | 是 | 是 | user-close | 是 |
| close-pane | 是 | 是 | 否 | 是 | user-close | 是 |
| delete-layout | 是 | 否 | 否 | 是 | user-close | 是 |
| snapshot-apply | 否 | 否 | 否 | 是 | user-close | 是 |
| backend-close | 否 | 否 | 否 | **否** | **null** | 是 |
| editor-path-close | 否 | 否 | 否 | **否** | **null** | 否 |

`commitResourceDestroy` 固定阶段顺序（**顺序不可变**，现有测试 `LayoutDeleteDialog.test.tsx:108-110` 锁死过等价顺序）：
1. detach 全部 sessionId（先全部解绑再杀，防杀 A 时 B 的 exit 回流）
2. kill 全部（扣除 `opts.protectSessionIds`；`kills=false` 的 reason 跳过整步）
3. `closePoppedWindows`（`closesPopups=true` 的 reason 生效）——实现参考 `web/components/layoutbar/LayoutDeleteDialog.tsx:67-81`，**必须同时回收两份真相**：`popupWindowService.markTabReclaimed(tabId)`（`web/services/popupWindowService.ts:45`）+ 窗口 `WebviewWindow.close()`。store 侧 `poppedOutTabs` Set 由轨 B 的 removeTabsInternal 清，本轨不碰。
4. per-tab `onClosed`（附属状态清理）

**测试**：
- 矩阵穷举：`Object.keys(DESTROY_POLICY)` 键集与手写全集双向相等（仿 `web/lib/tabContentType.test.ts` 范式，那是本仓库的标准穷举样板）。
- KillReason 映射三条双向语义锁：① `kills=true` → 映射非 null 且 **∉ {orphan-reclaim, daemon-reaper, launch-timeout}**（映射进回收类会命中 `terminalService.ts:296` 的"保留标签"分流，标签就关不掉了）；② `kills=false` → 映射为 null 且 commit 断言零 killSession 调用；③ `isTerminalReclaimKillReason`（`web/services/terminalLaunchDeadline.ts:8`）的三个值与本表回收类集合双向相等。
- registry 穷举：每种 contentType 必须登记且三方法皆函数；**顺带把 `web/lib/paneSessions.ts:40-54` 的 `collectTabsByContentType` 桶键集纳入同一断言**（第二处 contentType 穷举点，现在没有测试守着）。
- commit 阶段顺序断言（mock terminalService，断言 detach 早于 kill）。

## 轨 B · paneRemovalActions.ts 等量搬家（B1-03）

**文件**：`web/stores/usePanesStore.ts`（独占！其他轨不碰）、新建 `web/stores/paneRemovalActions.ts`、可能动 `web/stores/paneTreeHelpers.ts`、`web/test/lineRatchet.baseline.json`

**这一轨是纯结构搬家，行为必须零变化。**

1. 把六个 action 从 `usePanesStore.ts` **原样**迁入 `web/stores/paneRemovalActions.ts`：`closeTab`(:1637-1688)、`closeTabsToLeft`(:1690)、`closeTabsToRight`(:1717)、`closeOtherTabs`(:1743)、`closePane`(:1183-1255)、`closeTerminalPane`(:1945-1977)。**照抄 `web/stores/editorTabActions.ts` 的 `createEditorTabActions(set, get)` 工厂形态**，在 usePanesStore 里 spread 挂载。
2. 依赖的私有树辅助（`closeTabInTree`:487、`closeTerminalLeafInTab`:525、`findParent`、`normalizePaneTree` 等）下沉到 `web/stores/paneTreeHelpers.ts`（`findPane`/`collectPanels` 已在那里）。若 paneTreeHelpers 逼近 500 行则新建 `paneTreeRemovalHelpers.ts`。
3. 新增三个出口的**骨架**（本轨不接消费者，先无人调用）：
   - `removeTabsInternal(tabIds, reason, opts?)` — 唯一逐-tab 销毁出口
   - `removeTerminalLeafInternal(tabId, terminalPaneId, reason)` — 「关一格」
   - `removeEmptyPane(paneId)` — **纯树操作，零销毁语义**；收到非空 pane 时 no-op + dev 告警
4. **`usePanesStore.ts` 行数棘轮零余量**（`web/test/lineRatchet.baseline.json:21` 写着 2888，文件实际就是 2888 行）。搬家后 usePanesStore 净减，**同 commit 下调基线到实际行数**。

**关键警告**：`moveTab`(:1466) 与 `moveTabToLayoutPane`(:1540) 借道 `closePane` 关空 pane——它们是**搬走 tab 后收空壳，绝不能杀会话**。本轨只搬家不改语义，但要给 `removeEmptyPane` 写好"非空即拒"的守卫，B1-05 会把这两处改道过去。

## 轨 C · savedSessionId 口径（B1-12 + collectTerminalSessionIdsWithSaved）

**文件**：`web/lib/paneSessions.ts`、`web/components/layoutbar/layoutStatusSummary.ts`、`web/components/sidebar/workspaceTerminals.ts` + 对应测试

1. `paneSessions.ts` 新增（**紧挨现有 `collectTerminalSessionIds`，不要改它**）：
   ```ts
   /** 含 savedSessionId 的全量口径。restoring 中尚未 attach 的 savedSessionId 是真实 PTY，
    *  销毁/统计都必须算进去，否则漏杀成孤儿、少算成显示不一致。 */
   export function collectTerminalSessionIdsWithSaved(tab: Tab): string[];
   export function collectTerminalSessionIdsWithSavedFromTree(node: PaneNode): string[];
   ```
   语义：遍历 leaf 时并入 `leaf.savedSessionId`；非 terminal/无 terminalRootPane 的 tab 级兜底同样并入 `tab.savedSessionId`；去重 + filter 掉空值。
2. `layoutStatusSummary.ts:34-43` 与 `workspaceTerminals.ts:121-136` 改用新口径（现在只算 `sessionId`，恢复中的会话在状态块/工作区列表里少算，与批1 的确认弹窗计数对不上）。
3. 测试：新函数的分屏多 leaf / savedSessionId 并入 / 去重 / 非 terminal 退化四类用例；两个展示消费者的计数回归。

**注意**：这一轨是纯展示层对齐，零销毁风险，但要保证 `collectTerminalSessionIds`（旧口径）**保持原样**——它还有别的消费者。

## 轨 D · TabContextMenu 抽出 + 撤销接线（B1-13）

**文件**：`web/components/panes/TabBar.tsx`、新建 `web/components/panes/TabContextMenu.tsx`、`web/components/CommandPalette.tsx`、`web/hooks/useShortcutRegistrations.ts`、`web/stores/usePanesStore.ts` 的 `reopenClosedTab`（**只改这一个函数，其余不碰——轨 B 在搬家同文件的别处，改动要小且局部**）、i18n locales

1. **先抽组件**：`TabBar.tsx` 现在 807 行（棘轮冻结值），右键菜单内联在 `:353-528`。整块抽成 `TabContextMenu.tsx`（减约 170 行），**行为零变化**，抽完 TabBar 净减、同步下调 baseline。
2. **接撤销入口**（`reopenClosedTab` 在 `usePanesStore.ts:2193-2218`，已实现但**零调用方**，纯死代码）：
   - TabContextMenu 加一项「重新打开已关闭的标签」（i18n 文案**已存在**：`web/i18n/locales/{en,zh-CN}/panes.json:54`，带 `{{count}}`）；`closedTabs` 为空时禁用。
   - CommandPalette 加一条命令。
   - `useShortcutRegistrations.ts` 加 Ctrl+Shift+T（仿 `close-tab` 注册形态，:101-107）。
3. **修 `reopenClosedTab` 的丢字段 bug**：现在没透传 `title` 与 `launchClaude`（`ClosedTabSnapshot` 里都有）。修法：`customTitle: lastClosed.title` + `cliTool: lastClosed.cliTool ?? (lastClosed.launchClaude ? "claude" : undefined)`（`Panel.tsx` 的 `handleCloneTab` 有同款表达式先例）。
4. **`closedTabs` 加上限 20**：现在是 push-only 无上限（`usePanesStore.ts:1647`、`:1209` 两处 push）。**本轨只在 `reopenClosedTab` 侧/或新增裁剪工具函数里做**，push 点在轨 B 的搬家范围内——若需改 push 点，等 leader 协调，不要与轨 B 抢同一段代码。
5. 测试：`usePanesStore.test.ts:984-1010` 已有 reopenClosedTab 用例，补 title/cliTool 往返断言 + cap 20 断言（连关 30 个后 `closedTabs.length === 20`）。

## 轨间已知接触点（leader 已排除冲突，但要留意）

- 轨 A 调用轨 C 的 `collectTerminalSessionIdsWithSaved` —— 轨 A 先按签名写，import 暂时报错正常。
- 轨 B 与轨 D 都碰 `usePanesStore.ts`：轨 B 搬走 close 系六个 action（:1183-1255、:1637-1765、:1945-1977），轨 D 只碰 `reopenClosedTab`（:2193-2218）。**行段不重叠**，但 leader 会串行提交并处理可能的行号漂移。
- `closedTabs` 的 cap 20：push 点在轨 B 搬家范围，裁剪逻辑在轨 D。**两轨都不要单方面动 push 点**，由 leader 在 B1-05 收口。
