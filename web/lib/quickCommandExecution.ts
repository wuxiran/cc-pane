import { terminalService } from "@/services";
import { useDialogStore, usePanesStore } from "@/stores";
import type {
  QuickCommand,
  Tab,
  TerminalPaneLeaf,
  TerminalPaneNode,
} from "@/types";

export interface QuickCommandExecutionContext {
  paneId: string;
  tab: Tab;
}

interface SystemWriteOptions {
  source: "system";
}

export interface QuickCommandExecutionAdapter {
  submit: (sessionId: string, text: string) => Promise<void>;
  write: (
    sessionId: string,
    text: string,
    options: SystemWriteOptions,
  ) => Promise<void>;
  launchAgent: (
    command: QuickCommand,
    context: QuickCommandExecutionContext,
  ) => Promise<void>;
  launchTerminal: (
    command: QuickCommand,
    context: QuickCommandExecutionContext,
  ) => Promise<string>;
}

const sendQueues = new Map<string, Promise<void>>();

function findTerminalLeaf(
  node: TerminalPaneNode,
  paneId: string,
): TerminalPaneLeaf | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findTerminalLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

function firstTerminalLeaf(node: TerminalPaneNode): TerminalPaneLeaf | null {
  if (node.type === "leaf") return node;
  for (const child of node.children) {
    const found = firstTerminalLeaf(child);
    if (found) return found;
  }
  return null;
}

export function getQuickCommandSessionId(tab: Tab): string | null {
  if (tab.contentType !== "terminal") return null;
  if (!tab.terminalRootPane) return tab.sessionId;
  const activeLeaf = tab.activeTerminalPaneId
    ? findTerminalLeaf(tab.terminalRootPane, tab.activeTerminalPaneId)
    : null;
  return (activeLeaf ?? firstTerminalLeaf(tab.terminalRootPane))?.sessionId ?? null;
}

function enqueueSessionOperation(
  sessionId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = sendQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (sendQueues.get(sessionId) === next) sendQueues.delete(sessionId);
    });
  sendQueues.set(sessionId, next);
  return next;
}

function dispatchToSession(
  command: QuickCommand,
  sessionId: string,
  adapter: QuickCommandExecutionAdapter,
): Promise<void> {
  return enqueueSessionOperation(sessionId, () =>
    command.appendEnter
      ? adapter.submit(sessionId, command.text)
      : adapter.write(sessionId, command.text, { source: "system" }),
  );
}

function waitForTabSession(tabId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the quick command terminal session"));
    }, 20_000);

    const inspect = () => {
      const tab = usePanesStore.getState().findTabAcrossLayouts(tabId)?.tab;
      if (!tab) {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(new Error("Quick command terminal tab was closed before launch"));
        return;
      }
      if (tab.launchError) {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(new Error(tab.launchError.message));
        return;
      }
      const sessionId = getQuickCommandSessionId(tab);
      if (!sessionId) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(sessionId);
    };

    unsubscribe = usePanesStore.subscribe(inspect);
    inspect();
  });
}

async function launchAgent(
  command: QuickCommand,
  { tab }: QuickCommandExecutionContext,
): Promise<void> {
  if (!tab.projectPath || !command.cliTool || command.cliTool === "none") {
    throw new Error("Agent prompt quick commands require a project and CLI tool");
  }
  useDialogStore.getState().setPendingLaunch({
    path: tab.projectPath,
    workspaceName: tab.workspaceName,
    providerId: tab.providerId ?? "",
    providerSelection: tab.providerSelection,
    launchProfileId: tab.launchProfileId,
    workspacePath: tab.workspacePath,
    cliTool: command.cliTool,
    ssh: tab.ssh,
    wsl: tab.wsl,
    machineName: tab.machineName,
    initialPrompt: command.text,
  });
}

async function launchTerminal(
  command: QuickCommand,
  { paneId, tab }: QuickCommandExecutionContext,
): Promise<string> {
  if (!tab.projectPath) {
    throw new Error("Terminal quick commands require a project");
  }
  const panes = usePanesStore.getState();
  const pane = panes.findPaneById(paneId);
  if (!pane || pane.type !== "panel") {
    throw new Error("Quick command target pane is unavailable");
  }
  const existingTabIds = new Set(pane.tabs.map((item) => item.id));
  panes.addTab(paneId, {
    projectId: `quick-command-${crypto.randomUUID()}`,
    projectPath: tab.projectPath,
    workspaceName: tab.workspaceName,
    providerId: tab.providerId,
    providerSelection: tab.providerSelection,
    launchProfileId: tab.launchProfileId,
    workspacePath: tab.workspacePath,
    workspaceSnapshotId: tab.workspaceSnapshotId,
    cliTool: "none",
    customTitle: command.name,
    ssh: tab.ssh,
    wsl: tab.wsl,
    machineName: tab.machineName,
  });
  const updatedPane = usePanesStore.getState().findPaneById(paneId);
  const createdTab = updatedPane?.type === "panel"
    ? updatedPane.tabs.find((item) => !existingTabIds.has(item.id))
    : null;
  if (!createdTab) {
    throw new Error("Failed to create a terminal tab for the quick command");
  }
  return waitForTabSession(createdTab.id);
}

const defaultAdapter: QuickCommandExecutionAdapter = {
  submit: (sessionId, text) => terminalService.submitToSession(sessionId, text),
  write: (sessionId, text, options) => terminalService.write(sessionId, text, options),
  launchAgent,
  launchTerminal,
};

export async function executeQuickCommand(
  command: QuickCommand,
  context: QuickCommandExecutionContext,
  adapter: QuickCommandExecutionAdapter = defaultAdapter,
): Promise<void> {
  if (command.target === "currentPane") {
    const sessionId = getQuickCommandSessionId(context.tab);
    if (!sessionId) throw new Error("No active terminal session");
    await dispatchToSession(command, sessionId, adapter);
    return;
  }

  if (command.kind === "agentPrompt") {
    await adapter.launchAgent(command, context);
    return;
  }

  const sessionId = await adapter.launchTerminal(command, context);
  await dispatchToSession(command, sessionId, adapter);
}
