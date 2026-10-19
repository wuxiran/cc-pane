import type { Tab } from "@/types";
import type { CreateTabOptions } from "@/stores/panesStoreTypes";
import { terminalForkSource, type ChatForkMode } from "./chatForkService";
import { forkReviewService } from "./forkReviewService";

export async function forkWorkingDirectory(
  cwd: string,
  mode: ChatForkMode,
): Promise<string> {
  return (await forkReviewService.prepare({ cwd, mode })).cwd;
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
  const childTabId = `tab-${crypto.randomUUID()}`;
  // WSL paths belong to the distro; host-side snapshots must not inspect them.
  const prepared = source.wsl
    ? { cwd, record: null }
    : await forkReviewService.prepare({
        cwd, mode, sourceTabId: tab.id, childTabId,
        sourceSessionId: source.resumeId, title: tab.title, engineId: source.cliTool,
      });
  const destination = prepared.cwd;
  return {
    projectId: `proj-${crypto.randomUUID()}`,
    tabId: childTabId,
    forkReviewId: prepared.record?.id,
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
