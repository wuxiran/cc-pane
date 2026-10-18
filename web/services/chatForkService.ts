import type { Tab } from "@/types";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { worktreeService } from "./worktreeService";
import type { CreateTabOptions } from "@/stores/panesStoreTypes";

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

export async function forkWorkingDirectory(
  cwd: string,
  mode: ChatForkMode,
): Promise<string> {
  return mode === "worktree" ? worktreeService.forkChat(cwd) : cwd;
}

export async function buildTerminalFork(
  tab: Tab,
  mode: ChatForkMode,
): Promise<CreateTabOptions> {
  const source = terminalForkSource(tab);
  if (!source)
    throw new Error("This terminal has no supported conversation to fork");
  if (source.ssh)
    throw new Error("SSH conversation forks are not supported yet");
  if (source.wsl && mode === "worktree")
    throw new Error("Create WSL worktrees inside the WSL project first");
  const cwd =
    source.launchExtras?.launchCwd ??
    source.workspacePath ??
    source.projectPath;
  const destination = await forkWorkingDirectory(cwd, mode);
  return {
    projectId: `proj-${crypto.randomUUID()}`,
    projectPath: mode === "worktree" ? destination : source.projectPath,
    parentTabId: tab.id,
    workspaceName: source.workspaceName,
    providerId: source.providerId,
    modelId: source.modelId,
    providerSelection: source.providerSelection,
    launchProfileId: source.launchProfileId,
    workspacePath: mode === "worktree" ? undefined : source.workspacePath,
    cliTool: source.cliTool,
    wsl: source.wsl,
    machineName: source.machineName,
    // Deliberately no sessionId/resumeId/savedSessionId: these belong to the parent.
    launchExtras: {
      ...source.launchExtras,
      launchCwd: destination,
      initialPrompt: undefined,
      adapterOptions: {
        ...source.launchExtras?.adapterOptions,
        forkSessionId: source.resumeId,
        forkCwd: destination,
      },
    },
  };
}
