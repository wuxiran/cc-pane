import { useCallback, useEffect, useMemo, useState } from "react";
import { usePanesStore } from "@/stores";
import { liveGuardContext, planTabDestroy } from "@/lib/tabLifecycle/destroyPipeline";
import type { DestroyReason } from "@/lib/tabLifecycle/destroyPipeline";
import type { CloseGuard } from "@/lib/tabLifecycle/registry";
import type { Tab } from "@/types";

/**
 * 请求关闭「当前激活面板的当前标签」。
 *
 * close-tab 快捷键（Ctrl+W）派发本事件，激活面板收到后走与鼠标点 × 完全相同的
 * handleCloseTab —— pinned 保护、关闭确认、分屏标签全量回收只此一份实现，
 * 快捷键侧不再复制（复制过一次，结果漏杀分屏会话并绕过确认）。
 */
export const CLOSE_ACTIVE_TAB_EVENT = "cc-panes:close-active-tab";

/** 待确认的销毁请求：确认框打开期间只存 tabId，不存 Tab 引用（树随时可能变）。 */
interface PendingClose {
  tabIds: string[];
  guards: CloseGuard[];
  reason: DestroyReason;
}

export interface TabClosing {
  handleCloseTab: (tabId: string) => void;
  handleCloseTabsToLeft: (tabId: string) => void;
  handleCloseTabsToRight: (tabId: string) => void;
  handleCloseOtherTabs: (tabId: string) => void;
  /** 确认框要展示的条目；空数组 = 不打开。 */
  pendingGuards: CloseGuard[];
  cancelPendingClose: () => void;
  confirmPendingClose: () => void;
}

/**
 * 面板的关闭标签逻辑：pinned 保护 + 关闭确认 + 资源回收。
 *
 * 鼠标点 ×、右键批量关闭、close-tab 快捷键三个入口都收敛到这里；回收与树操作
 * 统一交给 store 的 removeTabsInternal（唯一销毁出口），此处只负责「问不问」。
 */
export function useTabClosing(paneId: string, tabs: Tab[], activeTabId?: string): TabClosing {
  const removeTabsInternal = usePanesStore((s) => s.removeTabsInternal);

  // B1-06：单一 pending 状态取代原先的 dirtyConfirmTabId + dirtyConfirmBatch 两个
  // state——确认项来自 planTabDestroy 的聚合（agent 忙 / 编辑器未保存），
  // 调用方不再需要知道「这次是因为什么弹的框」。
  const [pending, setPending] = useState<PendingClose | null>(null);

  /** 走一次销毁计划：有确认项就弹框，否则直接执行。 */
  const requestClose = useCallback(
    (targets: Tab[], reason: DestroyReason) => {
      if (targets.length === 0) return;
      const plan = planTabDestroy(targets, reason, liveGuardContext());
      const tabIds = plan.tabs.map((t) => t.id);
      if (tabIds.length === 0) return;
      if (plan.guards.length > 0) {
        setPending({ tabIds, guards: plan.guards, reason });
        return;
      }
      removeTabsInternal(tabIds, reason);
    },
    [removeTabsInternal],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || tab.pinned) return;
      requestClose([tab], "user-close");
    },
    [tabs, requestClose],
  );

  // close-tab 快捷键：只有激活面板响应，复用同一个 handleCloseTab
  useEffect(() => {
    function onCloseActiveTab() {
      if (usePanesStore.getState().activePaneId !== paneId) return;
      if (!activeTabId) return;
      handleCloseTab(activeTabId);
    }
    window.addEventListener(CLOSE_ACTIVE_TAB_EVENT, onCloseActiveTab);
    return () => window.removeEventListener(CLOSE_ACTIVE_TAB_EVENT, onCloseActiveTab);
  }, [paneId, activeTabId, handleCloseTab]);

  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => {
      const targetIdx = tabs.findIndex((t) => t.id === tabId);
      if (targetIdx < 0) return;
      requestClose(tabs.slice(0, targetIdx), "batch-close");
    },
    [tabs, requestClose],
  );

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      const targetIdx = tabs.findIndex((t) => t.id === tabId);
      if (targetIdx < 0) return;
      requestClose(tabs.slice(targetIdx + 1), "batch-close");
    },
    [tabs, requestClose],
  );

  const handleCloseOtherTabs = useCallback(
    (tabId: string) => {
      requestClose(tabs.filter((t) => t.id !== tabId), "batch-close");
    },
    [tabs, requestClose],
  );

  const confirmPendingClose = useCallback(() => {
    if (!pending) return;
    // 只传 tabId：确认框打开期间树可能已变（后端 kill / 跨端快照同步），
    // removeTabsInternal 会按当前树重新定位重新收集。
    removeTabsInternal(pending.tabIds, pending.reason);
    setPending(null);
  }, [pending, removeTabsInternal]);

  const cancelPendingClose = useCallback(() => setPending(null), []);

  const pendingGuards = useMemo(() => pending?.guards ?? [], [pending]);

  return {
    handleCloseTab,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    pendingGuards,
    cancelPendingClose,
    confirmPendingClose,
  };
}
