// 终端标签弹出为独立窗口：标签右键菜单与侧栏终端行菜单共用。
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { popOutTab, terminalService } from "@/services";
import type { PopupTabData } from "@/services/popupWindowService";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";

function findActiveLeaf(tab: Tab) {
  if (!tab.terminalRootPane || !tab.activeTerminalPaneId) return null;
  return collectTerminalLeaves(tab.terminalRootPane)
    .find((leaf) => leaf.id === tab.activeTerminalPaneId) ?? null;
}

export function findActiveTerminalSessionId(tab: Tab): string | null {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane || !tab.activeTerminalPaneId) {
    return tab.sessionId ?? null;
  }
  return findActiveLeaf(tab)?.sessionId ?? null;
}

/** 能弹出：活终端且尚未弹出。 */
export function canPopOutTerminalTab(tab: Tab): boolean {
  return tab.contentType === "terminal"
    && findActiveTerminalSessionId(tab) != null
    && !usePanesStore.getState().isTabPoppedOut(tab.id);
}

/** 先建弹出窗口，成功后再断开主窗口输出并标记；失败抛出由调用方提示。 */
export async function popOutTerminalTab(tab: Tab, paneId: string): Promise<void> {
  const sessionId = findActiveTerminalSessionId(tab);
  if (tab.contentType !== "terminal" || !sessionId) return;
  const store = usePanesStore.getState();
  if (store.isTabPoppedOut(tab.id)) return;
  const data: PopupTabData = {
    tabId: tab.id,
    paneId,
    sessionId,
    projectPath: tab.projectPath,
    title: tab.title,
    workspaceName: tab.workspaceName,
    providerId: tab.providerId,
    providerAccountId: tab.providerAccountId,
    modelId: tab.modelId,
    providerSelection: tab.providerSelection,
    launchProfileId: tab.launchProfileId,
    workspacePath: tab.workspacePath,
    cliTool: findActiveLeaf(tab)?.cliTool ?? tab.cliTool,
    launchClaude: findActiveLeaf(tab)?.launchClaude ?? tab.launchClaude,
  };
  await popOutTab(data);
  terminalService.detachOutput(sessionId);
  terminalService.detachExit(sessionId);
  store.markTabPoppedOut(tab.id);
}
