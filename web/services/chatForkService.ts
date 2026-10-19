import type { Tab } from "@/types";
import { collectTerminalLeaves } from "@/lib/paneSessions";

export type ChatForkMode = "same-directory" | "worktree";

export function terminalForkSource(tab: Tab) {
  if (tab.contentType !== "terminal" || !tab.projectPath) return null;
  const leaf = tab.terminalRootPane
    ? collectTerminalLeaves(tab.terminalRootPane).find(
        (item) => item.id === tab.activeTerminalPaneId,
      )
    : undefined;
  const source = leaf ? { ...tab, ...leaf } : tab;
  const cliTool = source.cliTool ?? (source.launchClaude ? "claude" : "none");
  if (
    !["claude", "codex"].includes(cliTool) ||
    !source.resumeId?.trim() ||
    source.resumeId === "new"
  )
    return null;
  return {
    ...source,
    cliTool,
    resumeId: source.resumeId,
    projectPath: tab.projectPath,
  };
}

export function supportsAcpFork(capabilities: unknown): boolean {
  const fork = (
    capabilities as { sessionCapabilities?: { fork?: unknown } } | null
  )?.sessionCapabilities?.fork;
  return fork !== null && typeof fork === "object" && !Array.isArray(fork);
}
