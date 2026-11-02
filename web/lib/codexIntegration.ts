import type { Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { activeTerminalLeaf } from "./paneSessions";

export const CODEX_APP_SERVER_ENGINE = "codex-app-server";
const VERIFIED_CLI_SOURCES = new Set(["hook", "osc-title", "backfill", "rescue"]);

export interface CodexOpenTarget { cwd: string; threadId?: string }

export function isCodexThreadId(value: unknown): value is string {
  return typeof value === "string" && value !== "new" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isLocalCodexPath(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value)
    && (/^\/(?!\/)/.test(value) || /^[A-Za-z]:[\\/]/.test(value));
}

export function codexEngineLabel(id: string, fallback = id): string {
  return id === "codex" ? "Codex (ACP)" : id === CODEX_APP_SERVER_ENGINE ? "Codex App Server" : fallback;
}

/** A task can originate in any local CLI/Agent, independently of its engine. */
export function codexHandoffWorkspace(tab: Tab, adoptedCwd?: string): string | null {
  if (tab.ssh || tab.wsl || !["terminal", "agent-chat"].includes(tab.contentType)) return null;
  const leaf = tab.contentType === "terminal" ? activeTerminalLeaf(tab) : null;
  if (leaf?.ssh || leaf?.wsl) return null;
  const terminal = leaf ?? tab;
  const cwd = tab.contentType === "agent-chat" ? adoptedCwd || tab.projectPath
    : terminal.launchExtras?.launchCwd || terminal.workspacePath || tab.projectPath;
  return isLocalCodexPath(cwd) ? cwd : null;
}

/** ACP session IDs are intentionally never used as Codex thread identifiers. */
export function codexOpenTarget(tab: Tab, snapshot?: AcpChatSnapshot | null, adoptedCwd?: string): CodexOpenTarget | null {
  if (tab.ssh || tab.wsl) return null;
  if (tab.contentType === "agent-chat") {
    const engine = snapshot?.engineId ?? tab.agentEngineId;
    if (engine !== "codex" && engine !== CODEX_APP_SERVER_ENGINE) return null;
    const cwd = adoptedCwd || tab.projectPath;
    const threadId = engine === CODEX_APP_SERVER_ENGINE && isCodexThreadId(snapshot?.codexThreadId) ? snapshot.codexThreadId : undefined;
    return threadId || isLocalCodexPath(cwd) ? { cwd, ...(threadId ? { threadId } : {}) } : null;
  }
  if (tab.contentType !== "terminal") return null;
  const leaf = activeTerminalLeaf(tab);
  if ((leaf?.cliTool ?? tab.cliTool) !== "codex" || leaf?.ssh || leaf?.wsl) return null;
  const terminal = leaf ?? tab;
  const cwd = terminal.launchExtras?.launchCwd || terminal.workspacePath || tab.projectPath;
  const resumeId = leaf ? leaf.resumeId : tab.resumeId;
  const source = leaf ? leaf.resumeIdSource : tab.resumeIdSource;
  const threadId = source && VERIFIED_CLI_SOURCES.has(source) && isCodexThreadId(resumeId) ? resumeId : undefined;
  return threadId || isLocalCodexPath(cwd) ? { cwd, ...(threadId ? { threadId } : {}) } : null;
}
