import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";

/**
 * 请求关闭「当前激活面板的当前标签」。
 *
 * close-tab 快捷键（Ctrl+W）派发本事件，激活面板收到后走与鼠标点 × 完全相同的
 * handleCloseTab —— pinned 保护、dirty 确认、分屏标签全量 kill 只此一份实现，
 * 快捷键侧不再复制（复制过一次，结果漏杀分屏会话并绕过确认）。
 */
export const CLOSE_ACTIVE_TAB_EVENT = "cc-panes:close-active-tab";

export interface TabClosing {
  handleCloseTab: (tabId: string) => void;
  handleCloseTabsToLeft: (tabId: string) => void;
  handleCloseTabsToRight: (tabId: string) => void;
  handleCloseOtherTabs: (tabId: string) => void;
  /** 单个 dirty 标签的确认对话框：非 null 时打开 */
  dirtyConfirmTabId: string | null;
  cancelDirtyConfirm: () => void;
  confirmCloseDirty: () => void;
  /** 批量关闭的确认对话框：非 null 时打开，值为 dirty 标签数 */
  dirtyConfirmBatchCount: number | null;
  cancelBatchConfirm: () => void;
  confirmBatchClose: () => void;
}

/**
 * 面板的关闭标签逻辑：pinned 保护 + dirty 确认 + 会话回收。
 *
 * 鼠标点 ×、右键批量关闭、close-tab 快捷键三个入口都收敛到这里。
 */
export function useTabClosing(paneId: string, tabs: Tab[], activeTabId?: string): TabClosing {
  const { closeTab, removeTabsInternal } = usePanesStore(
    useShallow((s) => ({
      closeTab: s.closeTab,
      removeTabsInternal: s.removeTabsInternal,
    })),
  );

  const [dirtyConfirmTabId, setDirtyConfirmTabId] = useState<string | null>(null);
  const [dirtyConfirmBatch, setDirtyConfirmBatch] = useState<{
    tabIds: string[];
    action: () => void;
  } | null>(null);

  // 执行单个 tab 关闭（不检查 dirty）。
  // B1-04 起会话回收归 store 出口统一处理，UI 侧不再自己 kill——两边都杀会
  // 重复调用（幂等但污染 dev 断言），半改道状态下更会漏杀。
  const doCloseTab = useCallback(
    (tabId: string) => {
      closeTab(paneId, tabId);
    },
    [paneId, closeTab],
  );

  // 关闭 tab（检查 pinned + dirty）
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || tab.pinned) return;
      if (tab.dirty) {
        setDirtyConfirmTabId(tabId);
        return;
      }
      doCloseTab(tabId);
    },
    [tabs, doCloseTab],
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

  const confirmCloseDirty = useCallback(() => {
    if (dirtyConfirmTabId) {
      doCloseTab(dirtyConfirmTabId);
      setDirtyConfirmTabId(null);
    }
  }, [dirtyConfirmTabId, doCloseTab]);

  // 批量关闭辅助：有 dirty tabs 则先弹确认。
  // 回收与树操作统一走 removeTabsInternal("batch-close")——pinned 豁免、
  // closedTabs 记录、会话回收全部按 DESTROY_POLICY 矩阵执行，此处不再自行判定。
  const doBatchClose = useCallback(
    (tabsToClose: Tab[]) => {
      const targetIds = tabsToClose.filter((t) => !t.pinned).map((t) => t.id);
      if (targetIds.length === 0) return;
      const dirtyTabs = tabsToClose.filter((t) => t.dirty && !t.pinned);
      if (dirtyTabs.length > 0) {
        setDirtyConfirmBatch({
          tabIds: dirtyTabs.map((t) => t.id),
          action: () => removeTabsInternal(targetIds, "batch-close"),
        });
        return;
      }
      removeTabsInternal(targetIds, "batch-close");
    },
    [removeTabsInternal],
  );

  const confirmBatchClose = useCallback(() => {
    if (dirtyConfirmBatch) {
      dirtyConfirmBatch.action();
      setDirtyConfirmBatch(null);
    }
  }, [dirtyConfirmBatch]);

  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => {
      const targetIdx = tabs.findIndex((t) => t.id === tabId);
      if (targetIdx < 0) return;
      doBatchClose(tabs.slice(0, targetIdx));
    },
    [tabs, doBatchClose],
  );

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      const targetIdx = tabs.findIndex((t) => t.id === tabId);
      if (targetIdx < 0) return;
      doBatchClose(tabs.slice(targetIdx + 1));
    },
    [tabs, doBatchClose],
  );

  const handleCloseOtherTabs = useCallback(
    (tabId: string) => {
      doBatchClose(tabs.filter((t) => t.id !== tabId));
    },
    [tabs, doBatchClose],
  );

  const cancelDirtyConfirm = useCallback(() => setDirtyConfirmTabId(null), []);
  const cancelBatchConfirm = useCallback(() => setDirtyConfirmBatch(null), []);

  return {
    handleCloseTab,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    dirtyConfirmTabId,
    cancelDirtyConfirm,
    confirmCloseDirty,
    dirtyConfirmBatchCount: dirtyConfirmBatch ? dirtyConfirmBatch.tabIds.length : null,
    cancelBatchConfirm,
    confirmBatchClose,
  };
}
