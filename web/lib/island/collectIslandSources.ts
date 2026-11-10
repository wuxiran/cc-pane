// 从主窗口 store 采集灵动岛数据源（纯函数：入参是 store 状态切片，便于单测）。
import { TOOL_LABELS } from "@/components/providers/launchProfileHelpers";
import { activeTerminalLeaf } from "@/lib/paneSessions";
import type { PendingChatPermission, AgentChatSessionState } from "@/stores/useAgentChatStore";
import type { TabAcrossLayoutsLocation } from "@/stores/panesStoreTypes";
import type { SessionCostEntry } from "@/stores/useSessionCostStore";
import { isBusyStatus, type TerminalStatusInfo } from "@/types/settings";
import type { KnownCliTool } from "@/types/terminal";
import type { IslandApproval, IslandQuota } from "@/types/island";
import { activeRateLimitWindows } from "@/utils/rateLimitDisplay";
import type { IslandSource } from "./islandSessionTracker";

const MAX_TEXT = 160;
const RECENT_ITEMS_SCANNED = 30;

export function cliLabel(tool: string | null | undefined): string {
  if (!tool) return "";
  return TOOL_LABELS[tool as KnownCliTool] || tool;
}

/** ACP engineId（claude / codex / codex-app-server …）→ CLI 显示名。 */
export function engineLabel(engineId: string | null | undefined): string {
  if (!engineId) return "";
  const known = (Object.keys(TOOL_LABELS) as KnownCliTool[])
    .find((tool) => tool !== "none" && engineId.toLowerCase().startsWith(tool));
  return known ? TOOL_LABELS[known] : engineId;
}

function clip(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export type LocateSession = (sessionId: string) => TabAcrossLayoutsLocation | null;

/** 终端会话：只收 agent CLI（cliTool ≠ none），普通 shell 跑 dev server 不算「会话在跑」。 */
export function collectTerminalSources(
  statusMap: ReadonlyMap<string, TerminalStatusInfo>,
  locate: LocateSession,
  summaries: ReadonlyMap<string, string>,
): IslandSource[] {
  const sources: IslandSource[] = [];
  for (const [sessionId, info] of statusMap) {
    const location = locate(sessionId);
    if (!location) continue;
    const { tab } = location;
    const leaf = activeTerminalLeaf(tab);
    const tool = leaf?.cliTool ?? tab.cliTool ?? (tab.launchClaude ? "claude" : "none");
    if (tool === "none") continue;
    const activity = info.status === "waitingInput"
      ? "needs"
      : isBusyStatus(info.status) ? "running" : "idle";
    sources.push({
      id: sessionId,
      kind: "terminal",
      name: tab.title || baseName(tab.projectPath),
      cli: cliLabel(tool),
      activity,
      detail: clip(info.currentToolSummary ?? info.currentToolName),
      approval: null,
      summary: clip(summaries.get(sessionId)),
    });
  }
  return sources;
}

function detailOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const input = rawInput as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value) return clip(value);
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      return clip(value.join(" "));
    }
  }
  return null;
}

/** 待批队首 → 岛审批卡：选项原样透传（不重排、不改名、不补选项）。 */
export function toIslandApproval(queue: readonly PendingChatPermission[]): IslandApproval | null {
  const head = queue[0];
  if (!head) return null;
  return {
    requestKey: head.requestKey,
    title: clip(head.params.toolCall?.title),
    detail: detailOf(head.params.toolCall?.rawInput),
    options: (head.params.options ?? []).map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    responding: head.responding,
    error: head.error,
    queued: queue.length - 1,
  };
}

function lastChatText(chat: AgentChatSessionState, type: "assistant" | "tool_call"): string | null {
  const items = chat.items;
  for (let i = items.length - 1; i >= Math.max(0, items.length - RECENT_ITEMS_SCANNED); i -= 1) {
    const item = items[i];
    if (type === "assistant" && item.type === "assistant") return clip(item.text);
    if (type === "tool_call" && item.type === "tool_call" && item.call.status !== "completed") {
      return clip(item.call.title);
    }
  }
  return null;
}

export type ChatName = (chatId: string) => string | null;

export function collectChatSources(
  chats: Readonly<Record<string, AgentChatSessionState>>,
  nameOf: ChatName,
): IslandSource[] {
  const sources: IslandSource[] = [];
  for (const [chatId, chat] of Object.entries(chats)) {
    if (!chat.snapshot) continue;
    const cli = engineLabel(chat.snapshot.engineId);
    const activity = chat.pendingPermissions.length > 0
      ? "needs"
      : chat.snapshot.phase === "generating" || chat.pendingPrompt ? "running" : "idle";
    sources.push({
      id: chatId,
      kind: "chat",
      name: nameOf(chatId) || cli || chatId,
      cli,
      activity,
      detail: activity === "running" ? lastChatText(chat, "tool_call") : null,
      approval: toIslandApproval(chat.pendingPermissions),
      summary: lastChatText(chat, "assistant"),
    });
  }
  return sources;
}

/** 额度是账号级的：取所有会话里最新观测到的一份，过期窗口丢掉。 */
export function pickQuota(
  sessions: ReadonlyMap<string, SessionCostEntry>,
  now: number,
): IslandQuota | null {
  let freshest: NonNullable<SessionCostEntry["snapshot"]>["rateLimits"] = null;
  for (const entry of sessions.values()) {
    const limits = entry.snapshot?.rateLimits;
    if (!limits) continue;
    if (!freshest || (limits.observedAt ?? 0) > (freshest.observedAt ?? 0)) freshest = limits;
  }
  const windows = activeRateLimitWindows(freshest, now);
  if (!freshest || windows.length === 0) return null;
  const provider = freshest.source.startsWith("codex") ? "Codex" : freshest.source;
  return { provider, windows };
}
