import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

export interface EditorTab {
  id: string;
  title: string;
  filePath: string;
  projectPath: string;
  dirty: boolean;
  pinned?: boolean;
}

interface EditorTabsState {
  tabs: EditorTab[];
  activeTabId: string | null;

  openFile: (projectPath: string, filePath: string, title: string) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  closeTabsToLeft: (tabId: string) => void;
  togglePin: (tabId: string) => void;
  selectTab: (tabId: string) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  activeTab: () => EditorTab | undefined;
}

function generateId(): string {
  return `etab-${crypto.randomUUID()}`;
}

export const useEditorTabsStore = create<EditorTabsState>()(
  persist(
    immer((set, get) => ({
      tabs: [],
      activeTabId: null,

      openFile: (projectPath: string, filePath: string, title: string) => {
        const state = get();
        // 去重：同一 filePath 不重复打开
        const existing = state.tabs.find((t) => t.filePath === filePath);
        if (existing) {
          set({ activeTabId: existing.id });
          return;
        }
        const newTab: EditorTab = {
          id: generateId(),
          title,
          filePath,
          projectPath,
          dirty: false,
        };
        set((s) => {
          s.tabs.push(newTab);
          s.activeTabId = newTab.id;
        });
      },

      closeTab: (tabId: string) => {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab || tab.pinned) return; // pinned 标签不可关闭
          const idx = s.tabs.findIndex((t) => t.id === tabId);
          s.tabs.splice(idx, 1);
          if (s.activeTabId === tabId) {
            if (s.tabs.length > 0) {
              const newIdx = Math.min(idx, s.tabs.length - 1);
              s.activeTabId = s.tabs[newIdx].id;
            } else {
              s.activeTabId = null;
            }
          }
        });
      },

      closeOtherTabs: (tabId: string) => {
        set((s) => {
          s.tabs = s.tabs.filter((t) => t.id === tabId || t.pinned);
          if (!s.tabs.some((t) => t.id === s.activeTabId)) {
            s.activeTabId = tabId;
          }
        });
      },

      closeTabsToRight: (tabId: string) => {
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          const kept = s.tabs.slice(0, idx + 1);
          const right = s.tabs.slice(idx + 1).filter((t) => t.pinned);
          s.tabs = [...kept, ...right];
          if (s.activeTabId && !s.tabs.some((t) => t.id === s.activeTabId)) {
            s.activeTabId = tabId;
          }
        });
      },

      closeTabsToLeft: (tabId: string) => {
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          const left = s.tabs.slice(0, idx).filter((t) => t.pinned);
          const kept = s.tabs.slice(idx);
          s.tabs = [...left, ...kept];
          if (s.activeTabId && !s.tabs.some((t) => t.id === s.activeTabId)) {
            s.activeTabId = tabId;
          }
        });
      },

      togglePin: (tabId: string) => {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (tab) tab.pinned = !tab.pinned;
        });
      },

      selectTab: (tabId: string) => {
        set({ activeTabId: tabId });
      },

      setDirty: (tabId: string, dirty: boolean) => {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (tab) tab.dirty = dirty;
        });
      },

      reorderTabs: (fromIndex: number, toIndex: number) => {
        set((s) => {
          if (fromIndex < 0 || fromIndex >= s.tabs.length) return;
          if (toIndex < 0 || toIndex >= s.tabs.length) return;
          const [moved] = s.tabs.splice(fromIndex, 1);
          s.tabs.splice(toIndex, 0, moved);
        });
      },

      activeTab: () => {
        const s = get();
        return s.tabs.find((t) => t.id === s.activeTabId);
      },
    })),
    {
      name: "cc-panes-editor-tabs",
      partialize: (state) => ({
        tabs: state.tabs.map((t) => ({
          ...t,
          dirty: false,
          pinned: t.pinned,
        })),
        activeTabId: state.activeTabId,
      }),
    }
  )
);
