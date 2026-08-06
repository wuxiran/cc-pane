// 降档判据与聚合订阅（docs/78）。
//
// 从 TerminalView 抽出：它已触到行数棘轮，且这两件事逻辑上属于同一个问题
// 「这个 PTY 现在还有人看吗」，与终端渲染细节无关。
import { useCallback, useEffect } from "react";
import { aggregateOf, useTabViewStateStore, viewKey } from "@/stores/useTabViewStateStore";
import type { ViewRole } from "@/stores/useTabViewStateStore";

/**
 * 降档/休眠判据：有 owner 时读聚合（**任一视图可见**），否则退回本视图。
 *
 * 同一个 PTY 可能被主标签、星标镜像、弹出窗口同时观看，只看自己会把
 * 「星标页正看着」的会话休眠掉——dispose xterm 时另一视图的写入路径踩空。
 * 只读第二视图（星标镜像）不传 owner：它不该独立决定 PTY 的降档，主视图
 * 会用聚合把它的可见性算进去。
 */
export function useDowngradeVisibility(
  owner: string | undefined,
  fallback: () => boolean,
): () => boolean {
  return useCallback(() => {
    if (!owner) return fallback();
    return aggregateOf(owner).anyVisible;
  }, [owner, fallback]);
}

/**
 * 订阅聚合变化。
 *
 * 同一 PTY 的**其他视图**（星标镜像、弹出窗口）可见性翻转时本组件不会
 * render，每帧 effect 够不着——没有这条订阅，「打开星标页」不会取消原 tab
 * 已经启动的休眠计时。
 */
export function useAggregateVisibilitySubscription(
  owner: string | undefined,
  notifyVisibility: (visible: boolean) => void,
): void {
  useEffect(() => {
    if (!owner) return;
    let last = aggregateOf(owner).anyVisible;
    return useTabViewStateStore.subscribe((state) => {
      const next = state.aggregate[owner]?.anyVisible ?? false;
      if (next === last) return;
      last = next;
      notifyVisibility(next);
    });
  }, [owner, notifyVisibility]);
}

/**
 * 单视图边沿订阅（纯函数版）：本视图（owner:role）在「可见 ↔ 不可见」之间
 * 翻转时回调。返回取消订阅函数。
 *
 * 与聚合订阅的分工：聚合回答「这个 PTY 还有没有人看」（降档/休眠判据），
 * 本订阅回答「**我这一个视图**刚刚显示出来了吗」。静默会话的隐藏积压必须在
 * 本视图翻可见的那一刻补投——主视图切回时若星标镜像一直开着，聚合
 * anyVisible 恒为 true 没有边沿，靠聚合订阅积压永远不 flush。
 *
 * 视图条目不存在（尚未上报 / 已退场）计为不可见；React19 dev 双挂载的
 * cleanup→mount 会产生一次可见边沿，flush 语义下幂等无害。
 */
export function subscribeViewVisibilityEdge(
  owner: string,
  role: ViewRole,
  onEdge: (visible: boolean) => void,
): () => void {
  const key = viewKey(owner, role);
  const isVisible = (views: Record<string, { visibility: string } | undefined>): boolean => {
    const v = views[key]?.visibility;
    return v !== undefined && v !== "hidden";
  };
  let last = isVisible(useTabViewStateStore.getState().views);
  return useTabViewStateStore.subscribe((state) => {
    const next = isVisible(state.views);
    if (next === last) return;
    last = next;
    onEdge(next);
  });
}

/** subscribeViewVisibilityEdge 的 hook 包装（TerminalView 用）。 */
export function useViewVisibilityEdgeSubscription(
  owner: string | undefined,
  role: ViewRole | undefined,
  onEdge: (visible: boolean) => void,
): void {
  useEffect(() => {
    if (!owner) return;
    return subscribeViewVisibilityEdge(owner, role ?? "primary", onEdge);
  }, [owner, role, onEdge]);
}

/**
 * TerminalView 的两个 store 读侧（单视图口径）。
 *
 * - isRenderVisible：本终端是否值得渲染。primary 写侧把「非当前 tab」与
 *   「非当前布局」都编码为 hidden，故等价覆盖旧 `isVisible && layoutActive`
 *   组合。条目未登记（首帧上报未跑）走 layoutFallback——后台布局启动期不多渲。
 * - isViewActive：tab 级焦点（leaf 级焦点由调用方以 leafFocused prop 组合）。
 *   条目未登记放行：refit 被误跳过的代价高于多 refit 一次。
 */
export function useViewVisibilityReaders(
  owner: string | undefined,
  role: ViewRole | undefined,
  layoutFallback: () => boolean,
): { isRenderVisible: () => boolean; isViewActive: () => boolean } {
  const isRenderVisible = useCallback(() => {
    if (!owner) return layoutFallback();
    const v = useTabViewStateStore.getState().getViewVisibility(owner, role ?? "primary");
    if (v === undefined) return layoutFallback();
    return v !== "hidden";
  }, [owner, role, layoutFallback]);
  const isViewActive = useCallback(() => resolveViewFocus(owner, role, () => true), [owner, role]);
  return { isRenderVisible, isViewActive };
}

/**
 * 焦点判据（scheduler 用）：本视图是不是焦点，决定要不要 refit。
 *
 * 与降档判据不同——那个问「有没有人在看」（聚合），这个问「焦点在不在我这」
 * （单视图）。首帧上报未跑时退回旧 ref，免得 refit 被误跳过。
 */
export function resolveViewFocus(
  owner: string | undefined,
  role: ViewRole | undefined,
  fallback: () => boolean,
): boolean {
  if (!owner) return fallback();
  const v = useTabViewStateStore.getState().getViewVisibility(owner, role ?? "primary");
  return v === undefined ? fallback() : v === "active";
}
