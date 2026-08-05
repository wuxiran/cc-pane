// 终端分屏树辅助（B1-03 自 usePanesStore.ts 原样下沉，行为零变化）。
//
// 为什么不并进 paneTreeHelpers.ts：这一组依赖 lib/paneSessions 与
// terminalRestoreMode，而 lib/paneSessions 反向 import 了 paneTreeHelpers 的
// collectPanels——并过去会成环。paneTreeHelpers 的「只依赖 @/types」约定被
// usePanesStore 头部注释显式依赖，必须守住。
import { collectTerminalLeaves } from "@/lib/paneSessions";
import type {
  Tab,
  TerminalPaneLeaf,
  TerminalPaneNode,
  TerminalPaneSplit,
} from "@/types";
import { generateId } from "./paneTreeHelpers";
import { inferCliTool, resolveRestoreMode } from "./terminalRestoreMode";

export function findTerminalPaneParent(
  node: TerminalPaneNode,
  paneId: string,
  parent: TerminalPaneSplit | null = null
): { parent: TerminalPaneSplit | null; index: number } | null {
  if (node.id === paneId) {
    return { parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i += 1) {
      const result = findTerminalPaneParent(node.children[i], paneId, node);
      if (result) return result;
    }
  }
  return null;
}

export function syncTabTerminalState(tab: Tab): void {
  if (tab.contentType !== "terminal") return;

  if (!tab.terminalRootPane) {
    const fallbackLeaf: TerminalPaneLeaf = {
      type: "leaf",
      id: generateId("terminal-pane"),
      launchId: generateId("launch"),
      restoreMode: resolveRestoreMode({
        cliTool: inferCliTool(tab.cliTool, tab.launchClaude, tab.resumeId),
        resumeId: tab.resumeId,
      }),
      sessionId: tab.sessionId ?? null,
      resumeId: tab.resumeId,
      resumeIdSource: tab.resumeIdSource,
      workspaceName: tab.workspaceName,
      providerId: tab.providerId,
      modelId: tab.modelId,
      providerSelection: tab.providerSelection,
      launchProfileId: tab.launchProfileId,
      workspacePath: tab.workspacePath,
      workspaceSnapshotId: tab.workspaceSnapshotId,
      cliTool: tab.cliTool,
      launchClaude: tab.launchClaude,
      ssh: tab.ssh,
      wsl: tab.wsl,
      machineName: tab.machineName,
      disconnected: tab.disconnected,
      restoring: tab.restoring,
      savedSessionId: tab.savedSessionId,
      restoreBlockedReason: tab.restoreBlockedReason,
      leaseReadOnly: tab.leaseReadOnly,
      launchError: tab.launchError,
      launchAttempt: tab.launchAttempt,
    };
    tab.terminalRootPane = fallbackLeaf;
    tab.activeTerminalPaneId = fallbackLeaf.id;
  }

  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  if (leaves.length === 0) return;

  const activeLeaf =
    (tab.activeTerminalPaneId
      ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
      : null) ?? leaves[0];

  tab.activeTerminalPaneId = activeLeaf.id;
  tab.sessionId = activeLeaf.sessionId;
  tab.resumeId = activeLeaf.resumeId;
  tab.resumeIdSource = activeLeaf.resumeIdSource;
  tab.workspaceName = activeLeaf.workspaceName;
  tab.providerId = activeLeaf.providerId;
  tab.modelId = activeLeaf.modelId;
  tab.providerSelection = activeLeaf.providerSelection;
  tab.launchProfileId = activeLeaf.launchProfileId;
  tab.workspacePath = activeLeaf.workspacePath;
  tab.workspaceSnapshotId = activeLeaf.workspaceSnapshotId;
  tab.cliTool = activeLeaf.cliTool;
  tab.launchClaude = activeLeaf.launchClaude;
  tab.ssh = activeLeaf.ssh;
  tab.wsl = activeLeaf.wsl;
  tab.machineName = activeLeaf.machineName;
  tab.disconnected = activeLeaf.disconnected;
  tab.restoring = activeLeaf.restoring;
  tab.savedSessionId = activeLeaf.savedSessionId;
  tab.restoreBlockedReason = activeLeaf.restoreBlockedReason;
  tab.leaseReadOnly = activeLeaf.leaseReadOnly;
  tab.launchError = activeLeaf.launchError;
  tab.launchAttempt = activeLeaf.launchAttempt;
}

export function closeTerminalLeafInTab(tab: Tab, terminalPaneId: string): boolean {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) return false;
  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  if (leaves.length <= 1) return false;

  const parentResult = findTerminalPaneParent(tab.terminalRootPane, terminalPaneId);
  if (!parentResult || parentResult.parent === null) return false;

  const parent = parentResult.parent;
  parent.children.splice(parentResult.index, 1);
  parent.sizes.splice(parentResult.index, 1);

  // 单 child 时保留 split 壳（不上提），避免幸存终端 remount；见 normalizePaneTree。
  const total = parent.sizes.reduce((sum, size) => sum + size, 0);
  parent.sizes = total > 0
    ? parent.sizes.map((size) => (size / total) * 100)
    : parent.children.map(() => 100 / parent.children.length);

  const nextLeaves = collectTerminalLeaves(tab.terminalRootPane);
  tab.activeTerminalPaneId = nextLeaves[Math.min(parentResult.index, nextLeaves.length - 1)]?.id;
  syncTabTerminalState(tab);
  return true;
}
