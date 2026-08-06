// 降档判据与聚合订阅（docs/78 批2 · B2-04）。
//
// 从 TerminalView 抽出：它已触到行数棘轮，且这两件事逻辑上属于同一个问题
// ——「这个 PTY 现在还有人看吗」，与终端渲染细节无关。
import { useCallback, useEffect } from "react";
import { aggregateOf, useTabViewStateStore } from "@/stores/useTabViewStateStore";
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
