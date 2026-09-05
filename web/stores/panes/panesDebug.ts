// 面板树 debug 日志助手。从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）。
import { devDebugLog } from "@/utils/devLogger";
import type { PaneNode } from "@/types";

export const PANES_DEBUG = import.meta.env.DEV;

export function summarizePanel(node: PaneNode | null) {
  if (node?.type !== "panel") return null;
  return {
    paneId: node.id,
    activeTabId: node.activeTabId,
    tabs: node.tabs.map((tab) => ({
      tabId: tab.id,
      sessionId: tab.sessionId ?? null,
      cliTool: tab.cliTool ?? (tab.launchClaude ? "claude" : "none"),
      projectPath: tab.projectPath,
    })),
  };
}

export function debugPanes(event: string, payload: Record<string, unknown>): void {
  if (!PANES_DEBUG) return;
  devDebugLog("panes-store-debug", event, payload);
}
