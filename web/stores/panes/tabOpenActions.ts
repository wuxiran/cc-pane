// 打开类 actions：项目/终端标签落位、关闭撤销、MCP/Skill/Memory/文件管理器标签。
// 从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）；在 usePanesStore 里 spread 挂载。
import { collectPanels, findPane, notifyTerminalLayoutChanged } from "@/lib/paneTree";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";
import {
  reopenNonTerminalSnapshot,
  restoreClosedTabIdentity,
  restoreClosedTabSplitTree,
  trimClosedTabs,
} from "../closedTabsUndo";
import { activateFirstNormalLayout, activeLayout, firstNormalLayout, isNormalLayout } from "../paneLayoutHelpers";
import type { PanesState } from "../panesStoreTypes";
import { createTab } from "./createTab";
import { findLayout } from "./layoutTraversal";
import { findTabAcrossLayouts } from "./crossLayoutSearch";
import type { PanesStoreAccess } from "./storeAccess";

export type TabOpenActions = Pick<
  PanesState,
  | "openProjectInPane"
  | "openProject"
  | "reopenClosedTab"
  | "openMcpConfig"
  | "openSkillManager"
  | "openMemoryManager"
  | "openFileExplorer"
>;

export function createTabOpenActions({ set, get }: PanesStoreAccess): TabOpenActions {
  return {
    openProjectInPane: (paneId, opts) => {
      const { projectId, resumeId, cliTool } = opts;
      set((state) => {
        if (!activateFirstNormalLayout(state)) return;
        const pane = findPane(state.rootPane, paneId) ?? findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;

        if (resumeId || (cliTool && cliTool !== "none")) {
          const newTab = createTab(opts);
          pane.tabs.push(newTab);
          pane.activeTabId = newTab.id;
          state.activePaneId = pane.id;
          return;
        }

        const existingTab = pane.tabs.find(
          (t) => t.projectId === projectId && !t.resumeId && !t.cliTool
        );
        if (existingTab) {
          pane.activeTabId = existingTab.id;
        } else {
          const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
          if (activeTab && !activeTab.projectPath) {
            const tabIndex = pane.tabs.indexOf(activeTab);
            const newTab = createTab({ ...opts, resumeId: undefined });
            pane.tabs.splice(tabIndex, 1, newTab);
            pane.activeTabId = newTab.id;
          } else {
            const newTab = createTab({ ...opts, resumeId: undefined });
            pane.tabs.push(newTab);
            pane.activeTabId = newTab.id;
          }
        }
        state.activePaneId = pane.id;
      });
      get().autoBindLayoutWorkspaceFromTabs();
      // 打开项目/终端 tab 也要落快照——让手机镜像近实时看到新 tab。
      notifyTerminalLayoutChanged("project.open");
    },

    openProject: (opts) => {
      // 布局绑定落位：显式指定目标布局且非当前布局时，先切过去再落位
      const { targetLayoutId } = opts;
      if (targetLayoutId && targetLayoutId !== get().currentLayoutId) {
        const target = findLayout(
          get().layouts,
          (layout) => layout.id === targetLayoutId && isNormalLayout(layout)
        );
        if (target) {
          get().switchLayout(targetLayoutId);
        }
      }
      if (activeLayout(get())?.kind === "starred") {
        const normal = firstNormalLayout(get().layouts);
        if (normal) {
          get().switchLayout(normal.id);
        }
      }
      const active = get().activePane();
      if (active) {
        get().openProjectInPane(active.id, opts);
      } else {
        // 壳状态下 rootPane 可能是单 child split，兜底到第一个 panel。
        const firstPanel = collectPanels(get().rootPane)[0];
        if (firstPanel) {
          get().openProjectInPane(firstPanel.id, opts);
        }
      }
    },

    reopenClosedTab: (paneId) => {
      const { closedTabs } = get();
      if (closedTabs.length === 0) return;

      const lastClosed = closedTabs[closedTabs.length - 1];
      set((state) => {
        state.closedTabs.pop();
        // 惰性裁剪兜底（严格上限在 removeTabsInternal 的 push 后）
        trimClosedTabs(state.closedTabs);
      });

      // 非终端撤销分流（docs/78）：browser/editor 各走自己的创建入口。
      // findEditorTabIdByPath 供 onRestoreState 定位新标签——openEditor 返回的
      // 是 layoutId，不能当 tabId 用。
      const reopenHost = {
        ...get(),
        findEditorTabIdByPath: (filePath: string): string | null => {
          const state = get();
          for (const panel of state.allPanelsAcrossLayouts()) {
            for (const tab of panel.tabs) {
              if (tab.contentType === "editor" && tab.filePath === filePath) return tab.id;
            }
          }
          return null;
        },
      };
      if (reopenNonTerminalSnapshot(reopenHost, lastClosed)) return;

      get().addTab(paneId, {
        projectId: lastClosed.projectId,
        projectPath: lastClosed.projectPath,
        resumeId: lastClosed.resumeId,
        workspaceName: lastClosed.workspaceName,
        providerId: lastClosed.providerId,
        modelId: lastClosed.modelId,
        providerSelection: lastClosed.providerSelection,
        launchProfileId: lastClosed.launchProfileId,
        workspacePath: lastClosed.workspacePath,
        workspaceSnapshotId: lastClosed.workspaceSnapshotId,
        // title/launchClaude 此前被丢弃（docs/68 §2.2）；写法对齐 Panel.handleCloneTab
        customTitle: lastClosed.title,
        cliTool: lastClosed.cliTool ?? (lastClosed.launchClaude ? "claude" : undefined),
        ssh: lastClosed.ssh,
        wsl: lastClosed.wsl,
        machineName: lastClosed.machineName,
        parentTabId: lastClosed.parentTabId,
        launchExtras: lastClosed.launchExtras,
      });

      // 分屏结构回放（docs/78 批4）：addTab 只建单格。
      restoreClosedTabSplitTree(
        (tabId, root, activeLeafId) => {
          set((state) => {
            const location = findTabAcrossLayouts(state, tabId);
            if (!location) return;
            location.tab.terminalRootPane = root;
            location.tab.activeTerminalPaneId = activeLeafId;
          });
        },
        get().findPaneById,
        paneId,
        lastClosed,
      );
      restoreClosedTabIdentity(get(), paneId, lastClosed);
    },

    openMcpConfig: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      // Reuse the existing tab if the project is already open here.
      const existing = active.tabs.find(
        (t) => t.contentType === "mcp-config" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab = createTabOfType("mcp-config", {
          title: `MCP - ${title}`,
          projectPath,
        });
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openSkillManager: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "skill-manager" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab = createTabOfType("skill-manager", {
          title: `Skill - ${title}`,
          projectPath,
        });
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openMemoryManager: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "memory-manager" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab = createTabOfType("memory-manager", {
          title: `Memory - ${title}`,
          projectPath,
        });
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },

    openFileExplorer: (projectPath, title) => {
      const active = get().activePane();
      if (!active) return;

      const existing = active.tabs.find(
        (t) => t.contentType === "file-explorer" && t.projectPath === projectPath
      );
      if (existing) {
        get().selectTab(active.id, existing.id);
        return;
      }

      set((state) => {
        const pane = findPane(state.rootPane, state.activePaneId);
        if (pane?.type !== "panel") return;
        const newTab = createTabOfType("file-explorer", {
          title: `Explorer - ${title}`,
          projectPath,
        });
        pane.tabs.push(newTab);
        pane.activeTabId = newTab.id;
      });
    },
  };
}
