// 前端 hidden 会话上报（docs/78）。
//
// 链路：本 hook 订阅可见性聚合 → Tauri command → app 侧 control link →
// daemon 按连接把这些会话的输出在**源头**断流（delta 照常累积，unhide 走
// desync 快照重建）。
//
// **上报不保证生效**：旧 daemon 静默丢弃、断线期间无投递、web 直连模式没有
// control 通道。前端 512KB 积压是永久兜底，不因上报而放松——这条写进了
// docs/78 与 CLAUDE.md。
import { useEffect } from "react";
import { usePanesStore } from "@/stores";
import { useTabViewStateStore, type ViewAggregate } from "@/stores/useTabViewStateStore";
import { collectTabs, collectTerminalSessionIdsWithSaved } from "@/lib/paneSessions";
import { invokeIfTauri, isTauriRuntime } from "@/services/runtime";
import type { LayoutEntry, PaneNode } from "@/types";

const REPORT_DEBOUNCE_MS = 800;

/**
 * 从聚合表 + 布局树推导「当前不可见的会话全集」。纯函数，便于测试。
 *
 * 三条口径规则：
 * 1. 只算**有聚合记录且 anyVisible=false** 的 owner——从未上报过的 owner
 *    走安全默认（不上报隐藏），宁可多推流也不错杀；
 * 2. owner=tabId 时会话集取自当前树（含 savedSessionId，与销毁口径一致）；
 * 3. selfchat: 前缀的 owner 不在 pane 树里，它的会话由 SelfChat 自己的
 *    生命周期管，本上报不覆盖（它没有 daemon 镜像诉求）。
 */
export function deriveHiddenSessions(
  aggregate: Record<string, ViewAggregate>,
  layouts: Array<Pick<LayoutEntry, "id" | "rootPane">>,
  currentLayoutId: string,
  currentRootPane: PaneNode,
  isPoppedOut: (tabId: string) => boolean,
): string[] {
  const hiddenOwners = new Set<string>();
  for (const [owner, agg] of Object.entries(aggregate)) {
    if (owner.startsWith("selfchat:")) continue;
    // **弹出标签必须排除**：弹窗在独立 WebView、
    // 独立 store，它的 popup 视图上报主窗口永远看不见——主窗口切走后本
    // 派生会把它判成 hidden，而 daemon 掐的是整个 app 连接（Rust 桥被两个
    // WebView 共用），结果是**弹窗里正在看的终端冻结**。弹出期间一律视为
    // 可见，宁可多推流。
    if (isPoppedOut(owner)) continue;
    if (!agg.anyVisible) hiddenOwners.add(owner);
  }
  if (hiddenOwners.size === 0) return [];

  const sessions = new Set<string>();
  for (const layout of layouts) {
    const tree = layout.id === currentLayoutId ? currentRootPane : layout.rootPane;
    if (!tree) continue;
    for (const tab of collectTabs(tree)) {
      if (!hiddenOwners.has(tab.id)) continue;
      for (const sid of collectTerminalSessionIdsWithSaved(tab)) {
        sessions.add(sid);
      }
    }
  }
  return [...sessions].sort();
}

/** 挂载一次（App 级）。订阅聚合变化，去抖后全量上报。 */
export function useHiddenSessionReporter(): void {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReported = "";

    const report = () => {
      const panes = usePanesStore.getState();
      const hidden = deriveHiddenSessions(
        useTabViewStateStore.getState().aggregate,
        panes.layouts,
        panes.currentLayoutId,
        panes.rootPane,
        (tabId) => panes.poppedOutTabs.has(tabId),
      );
      const key = hidden.join(",");
      // 同值不重发：聚合高频变化，但 hidden 全集往往不变
      if (key === lastReported) return;
      lastReported = key;
      void invokeIfTauri("set_hidden_terminal_sessions", { sessions: hidden });
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, REPORT_DEBOUNCE_MS);
    };

    const unsubscribe = useTabViewStateStore.subscribe(schedule);
    // poppedOutTabs 的翻转也影响派生（弹出/收回不经过可见性聚合），
    // 同值去抖比较会吸收无关的 panes store 变化。
    const unsubscribePanes = usePanesStore.subscribe(schedule);
    schedule();

    return () => {
      unsubscribe();
      unsubscribePanes();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
