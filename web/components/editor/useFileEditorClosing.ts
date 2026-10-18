import { useState } from "react";
import { useEditorTabsStore, type EditorTab } from "@/stores/useEditorTabsStore";
import type { CloseGuard } from "@/lib/tabLifecycle/registry";

interface PendingClose {
  ids: string[];
  preferredActiveId: string;
  guards: CloseGuard[];
}

/** Files-mode close uses the same unsaved-file confirmation as pane tabs. */
export function useFileEditorClosing(tabs: EditorTab[]) {
  const [pending, setPending] = useState<PendingClose | null>(null);

  function request(candidates: EditorTab[], preferredActiveId: string, close: () => void) {
    const closing = candidates.filter((tab) => !tab.pinned);
    const guards: CloseGuard[] = closing.filter((tab) => tab.dirty).map((tab) => ({
      kind: "editor-dirty", tabId: tab.id, tabTitle: tab.title,
    }));
    if (guards.length === 0) close();
    else setPending({ ids: closing.map((tab) => tab.id), preferredActiveId, guards });
  }

  function confirm() {
    if (!pending) return;
    const store = useEditorTabsStore.getState();
    const activeWasClosed = pending.ids.includes(store.activeTabId ?? "");
    // Freeze the reviewed set: tabs opened while confirmation is pending are not discarded.
    for (const id of pending.ids) store.closeTab(id);
    const remaining = useEditorTabsStore.getState().tabs;
    if (activeWasClosed && remaining.some((tab) => tab.id === pending.preferredActiveId)) {
      store.selectTab(pending.preferredActiveId);
    }
    setPending(null);
  }

  return {
    guards: pending?.guards ?? [],
    cancel: () => setPending(null),
    confirm,
    closeTab: (id: string) => request(tabs.filter((tab) => tab.id === id), id,
      () => useEditorTabsStore.getState().closeTab(id)),
    closeOtherTabs: (id: string) => request(tabs.filter((tab) => tab.id !== id), id,
      () => useEditorTabsStore.getState().closeOtherTabs(id)),
    closeTabsToRight: (id: string) => request(tabs.slice(tabs.findIndex((tab) => tab.id === id) + 1), id,
      () => useEditorTabsStore.getState().closeTabsToRight(id)),
    closeTabsToLeft: (id: string) => request(tabs.slice(0, tabs.findIndex((tab) => tab.id === id)), id,
      () => useEditorTabsStore.getState().closeTabsToLeft(id)),
  };
}
