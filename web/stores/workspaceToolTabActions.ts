// 工作空间级工具标签（Skills / Memory）：复用项目级 contentType，以「projectPath 为空 +
// workspaceName」标识工作空间视图（docs/98 workspace-first）。同一窗格内同工作空间只开一个。
import type { PanesDraft } from "./panesStoreTypes";
import type { PaneNode, Panel } from "@/types";
import { findPane } from "@/lib/paneTree";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";

type WorkspaceToolType = "skill-manager" | "memory-manager" | "mcp-config";

const TITLE_PREFIX: Record<WorkspaceToolType, string> = {
  "skill-manager": "Skill",
  "memory-manager": "Memory",
  "mcp-config": "MCP",
};

export interface WorkspaceToolTabActions {
  openWorkspaceSkillManager: (workspaceName: string, title: string) => void;
  openWorkspaceMemoryManager: (workspaceName: string, title: string) => void;
  openWorkspaceMcpConfig: (workspaceName: string, title: string) => void;
}

interface StoreAccess {
  set: (recipe: (state: PanesDraft) => void) => void;
  get: () => {
    activePane: () => Panel | null;
    selectTab: (paneId: string, tabId: string) => void;
    rootPane: PaneNode;
    activePaneId: string;
  };
}

export function createWorkspaceToolTabActions({ set, get }: StoreAccess): WorkspaceToolTabActions {
  const open = (contentType: WorkspaceToolType, workspaceName: string, title: string) => {
    const active = get().activePane();
    if (!active) return;
    const existing = active.tabs.find(
      (t) => t.contentType === contentType && !t.projectPath && t.workspaceName === workspaceName,
    );
    if (existing) {
      get().selectTab(active.id, existing.id);
      return;
    }
    set((state) => {
      const pane = findPane(state.rootPane, state.activePaneId);
      if (pane?.type !== "panel") return;
      const newTab = createTabOfType(contentType, {
        title: `${TITLE_PREFIX[contentType]} - ${title}`,
        projectPath: "",
        workspaceName,
      });
      pane.tabs.push(newTab);
      pane.activeTabId = newTab.id;
    });
  };
  return {
    openWorkspaceSkillManager: (workspaceName, title) => open("skill-manager", workspaceName, title),
    openWorkspaceMemoryManager: (workspaceName, title) => open("memory-manager", workspaceName, title),
    openWorkspaceMcpConfig: (workspaceName, title) => open("mcp-config", workspaceName, title),
  };
}
