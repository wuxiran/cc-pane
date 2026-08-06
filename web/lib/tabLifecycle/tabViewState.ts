// 组件级视图状态的暂存（docs/78 批4 的 onPersist / onRestoreState）。
//
// 「标签数据」与「视图状态」是两回事：filePath 属于标签（关了还在快照里），
// 光标停在第几行属于**视图**——它活在组件实例里，组件一卸载就没了。销毁管线
// 却必须在组件**可能从未挂载**的情况下也能工作（快照覆盖 / 后台布局删除，
// docs/78 §2.1 双轨纪律），所以视图状态不能靠「关闭时问组件要」，只能由组件
// 在活着的时候持续上报到这里，销毁时从这里读。
//
// 用模块级 Map 而不是 zustand：写入频率高（每次光标移动），且没有任何渲染
// 需要订阅它——进 store 只会让整棵布局树的订阅者陪着重渲染。

/** 各 contentType 的视图状态并集。字段全可选：读不到就是没上报过。 */
export interface TabViewState {
  /** editor：Monaco 光标位置（1-based，与 Monaco 及 useEditorRevealStore 同口径）。 */
  editorCursor?: { line: number; column: number };
}

const viewStates = new Map<string, TabViewState>();

/** 组件上报（浅合并：各字段的上报点互不相干，整体覆盖会互相抹掉）。 */
export function reportTabViewState(tabId: string, patch: TabViewState): void {
  if (!tabId) return;
  viewStates.set(tabId, { ...viewStates.get(tabId), ...patch });
}

export function readTabViewState(tabId: string): TabViewState | undefined {
  return viewStates.get(tabId);
}

/**
 * 随标签销毁清除。不清的话，Map 会随开关标签无限增长——这类「按 id 记账却没有
 * 回收点」的 Map 正是批1 之前的泄漏形态。
 */
export function clearTabViewState(tabId: string): void {
  viewStates.delete(tabId);
}

/** 测试用。 */
export function resetTabViewStates(): void {
  viewStates.clear();
}

/** 观测用：当前暂存条目数（泄漏断言）。 */
export function tabViewStateCount(): number {
  return viewStates.size;
}
