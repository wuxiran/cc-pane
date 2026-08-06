# -*- coding: utf-8 -*-
import io

p = 'web/stores/paneRemovalActions.ts'
s = io.open(p, encoding='utf-8').read()

def sub(old, new):
    global s
    assert old in s, "MISS: %r" % old[:90]
    s = s.replace(old, new, 1)

# 1) type import for DestroyPolicy
sub('''import type { DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";''',
    '''import type { DestroyPolicy, DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";''')

# 2) insert the three private functions before createPaneRemovalActions
sub('''export function createPaneRemovalActions(''',
'''/**
 * removeTabsInternal 第一段：树 splice 前按当前树**重新定位**、收集要回收的
 * tab，并发起资源回收（回收先于树操作：splice 后 tab 数据就找不回来了）。
 *
 * 重定位重收集而非信任调用方传来的 Tab 引用：确认弹窗打开期间树可能变化
 * （后端 kill / 跨端快照同步），拿旧引用去杀会杀错对象。
 *
 * 历史快照互覆盖会造成**跨布局同 id 的分叉副本**，收集必须逐位置进行、不能
 * 按 tab.id 去重——去重会漏掉后续副本的资源（不同 sessionId 的分叉副本成
 * 孤儿）。pinned 豁免的副本仍在树上显示它的会话：该会话必须进保护集，否则
 * 「杀掉 pinned 副本正在用的会话」= 一个杀不掉的死终端。
 */
function relocateAndCollect(
  state: PanesState,
  tabIds: string[],
  policy: DestroyPolicy,
  reason: DestroyReason,
  opts: RemoveTabsInternalOptions | undefined,
): void {
  const doomedTabs: Tab[] = [];
  const pinnedProtected = new Set<string>();
  for (const tabId of tabIds) {
    for (const layout of state.layouts) {
      const tree = layout.id === state.currentLayoutId ? state.rootPane : layout.rootPane;
      if (!tree) continue;
      const location = findTabLocation(tree, tabId);
      if (!location) continue;
      if (policy.respectsPinned && location.tab.pinned) {
        for (const sid of collectTerminalSessionIdsWithSaved(location.tab)) {
          pinnedProtected.add(sid);
        }
        continue;
      }
      doomedTabs.push(location.tab);
    }
  }
  // commitResourceDestroy 内部按矩阵决定杀不杀（backend-close 的 PTY 已死，
  // kills=false 整步跳过）。
  if (doomedTabs.length > 0) {
    const protect = pinnedProtected.size > 0
      ? new Set([...(opts?.protectSessionIds ?? []), ...pinnedProtected])
      : opts?.protectSessionIds;
    void commitResourceDestroy(doomedTabs, reason, { protectSessionIds: protect });
  }
}

/**
 * removeTabsInternal 第二段：逐 tab × 逐布局（含星标——镜像标签同样要能移除）
 * 树 splice + closedTabs 撤销快照。pinned 豁免与第一段同口径判定（两处判据
 * 必须一致，否则会出现「资源杀了但标签还在」或反之）。
 * 同 id 继续扫完其余布局（历史快照互覆盖的跨布局分叉副本要移除干净）。
 */
function spliceAcrossLayouts(
  state: PanesDraft,
  tabIds: string[],
  policy: DestroyPolicy,
  removedIds: Set<string>,
): void {
  for (const tabId of tabIds) {
    for (const layout of state.layouts) {
      const isCurrent = layout.id === state.currentLayoutId;
      const tree = isCurrent ? state.rootPane : layout.rootPane;
      if (!tree) continue;
      const location = findTabLocation(tree, tabId);
      if (!location) continue;
      const { panel, tab } = location;
      if (policy.respectsPinned && tab.pinned) continue;

      if (policy.recordsClosedTabs && tab.projectPath && tab.contentType === "terminal") {
        state.closedTabs.push(toClosedTabSnapshot(tab));
      } else if (policy.recordsClosedTabs) {
        // 非终端撤销（docs/78）：browser 存 URL、editor 存 filePath。
        const snap = TAB_LIFECYCLE[tab.contentType].persistForUndo?.(tab);
        if (snap) state.closedTabs.push(snap);
      }

      // pinned 语义已按矩阵判过，这里恒 force。
      const nextTree = closeTabInTree(tree, panel.id, tabId, true);
      assignTreeAndConvergeActive(isCurrent ? state : layout, nextTree);
      removedIds.add(tabId);
    }
  }
  if (removedIds.size > 0) {
    trimClosedTabs(state.closedTabs);
  }
}

/**
 * removeTabsInternal 第三段：附属状态清理——poppedOutTabs / 全屏退出 /
 * owner 键卫星态清扫（视图聚合 + 注意标记，不清的话死标签会被 hidden 上报
 * 当「可见」报给 daemon）+ 布局变更通知。
 */
function cleanupSatelliteState(
  set: (recipe: (state: PanesDraft) => void) => void,
  get: () => PanesState,
  removedIds: Set<string>,
): void {
  const popped = get().poppedOutTabs;
  const stalePopped = [...removedIds].filter((id) => popped.has(id));
  if (stalePopped.length > 0) {
    const next = new Set(popped);
    for (const id of stalePopped) next.delete(id);
    set((state) => {
      state.poppedOutTabs = next;
    });
  }
  const fullscreen = useFullscreenStore.getState();
  if (fullscreen.fullscreenTabId && removedIds.has(fullscreen.fullscreenTabId)) {
    void fullscreen.exitFullscreen();
  }
  sweepOwnerState(removedIds);
  notifyTerminalLayoutChanged("tab.remove");
}

export function createPaneRemovalActions(''')

# 3) replace the monolithic body with the orchestrator
i0 = s.index('    removeTabsInternal: (tabIds, reason, opts) => {')
i1 = s.index('    removeTerminalLeafInternal: (tabId, terminalPaneId, reason) => {')
orchestrator = '''    removeTabsInternal: (tabIds, reason, opts) => {
      // 唯一逐-tab 销毁出口，三段编排（docs/78 §8）：
      // relocateAndCollect（回收先于树操作）→ spliceAcrossLayouts（树 splice
      // + closedTabs）→ cleanupSatelliteState（附属清理 + 通知）。
      // 幂等：找不到的 tabId 静默跳过。
      if (tabIds.length === 0) return;
      const policy = DESTROY_POLICY[reason];
      relocateAndCollect(get(), tabIds, policy, reason, opts);
      const removedIds = new Set<string>();
      set((state) => spliceAcrossLayouts(state, tabIds, policy, removedIds));
      if (removedIds.size === 0) return;
      cleanupSatelliteState(set, get, removedIds);
    },

'''
s = s[:i0] + orchestrator + s[i1:]

io.open(p, 'w', encoding='utf-8').write(s)
print('split done')
