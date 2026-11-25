import { usePanesStore } from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { findPane } from "@/lib/paneTree";
import { findTerminalPane } from "@/lib/paneSessions";
import type { LaunchProviderSelection, PaneNode, TerminalPaneLeaf } from "@/types";
import type { LaunchProfileSnapshot } from "@/types/launch-profile-snapshot";

interface ActiveTerminalState {
  rootPane: PaneNode;
  activePaneId: string;
}

export interface ActiveTerminalContext {
  sessionId: string | null;
  cliTool: string | null;
  ssh: boolean;
  providerId: string | null;
  /** 供应商下的账号（只读展示运行配置的凭证用）；缺省 = 供应商默认账号。 */
  providerAccountId?: string | null;
  modelId: string | null;
  providerSelection: LaunchProviderSelection | null;
  launchProfileId: string | null;
  /** 启动时实际用的运行配置快照；旧数据没有。 */
  launchProfileSnapshot?: LaunchProfileSnapshot | null;
}

export function selectActiveTerminalLeaf(state: ActiveTerminalState): TerminalPaneLeaf | null {
  const pane = findPane(state.rootPane, state.activePaneId);
  if (!pane || pane.type !== "panel") return null;
  const tab = pane.tabs.find((item) => item.id === pane.activeTabId);
  if (!tab || tab.contentType !== "terminal") return null;
  if (tab.terminalRootPane) {
    const leaf = findTerminalPane(
      tab.terminalRootPane,
      tab.activeTerminalPaneId ?? "",
    );
    return leaf?.type === "leaf"
      ? {
          ...leaf,
          cliTool: leaf.cliTool ?? tab.cliTool,
          ssh: leaf.ssh ?? tab.ssh,
          wsl: leaf.wsl ?? tab.wsl,
        }
      : null;
  }
  return tab.sessionId
    ? {
        type: "leaf",
        id: tab.id,
        sessionId: tab.sessionId,
        cliTool: tab.cliTool,
        resumeId: tab.resumeId,
        providerId: tab.providerId,
        modelId: tab.modelId,
        providerSelection: tab.providerSelection,
        launchProfileId: tab.launchProfileId,
        launchProfileSnapshot: tab.launchProfileSnapshot,
        wsl: tab.wsl,
        ssh: tab.ssh,
      }
    : null;
}

export function selectActiveTerminalSessionId(state: ActiveTerminalState): string | null {
  return selectActiveTerminalLeaf(state)?.sessionId ?? null;
}

export function selectActiveTerminalContext(state: ActiveTerminalState): ActiveTerminalContext | null {
  const leaf = selectActiveTerminalLeaf(state);
  if (!leaf) return null;
  return {
    sessionId: leaf.sessionId,
    cliTool: leaf.cliTool?.toLowerCase() ?? null,
    ssh: Boolean(leaf.ssh),
    providerId: leaf.providerId?.trim() || null,
    modelId: leaf.modelId?.trim() || null,
    providerSelection: leaf.providerSelection ?? null,
    launchProfileId: leaf.launchProfileId?.trim() || null,
    launchProfileSnapshot: leaf.launchProfileSnapshot ?? null,
  };
}

export function useActiveTerminalSessionId(): string | null {
  return usePanesStore(selectActiveTerminalSessionId);
}

export function useActiveTerminalContext(): ActiveTerminalContext | null {
  return usePanesStore(useShallow(selectActiveTerminalContext));
}
