import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, listenIfTauri } from "./runtime";
import type { AcpChatEvent, AcpChatSnapshot, AcpEngineInfo } from "@/types/agentChat";

export const ACP_CHAT_EVENT = "acp-chat-event";

export class AgentChatUnavailableError extends Error {
  readonly code = "UNAVAILABLE";

  constructor() {
    super("Agent chat is only available in the desktop app");
  }
}

function requireDesktop(): void {
  if (!isTauriRuntime()) throw new AgentChatUnavailableError();
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  requireDesktop();
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

export function listAcpEngines(): Promise<AcpEngineInfo[]> {
  return call("list_acp_engines");
}

export function startAcpChat(
  chatId: string,
  engineId: string,
  cwd: string,
): Promise<AcpChatSnapshot> {
  return call("start_acp_chat", { chatId, engineId, cwd });
}

export function promptAcpChat(chatId: string, message: string): Promise<void> {
  return call("prompt_acp_chat", { chatId, message });
}

export function cancelAcpChat(chatId: string): Promise<void> {
  return call("cancel_acp_chat", { chatId });
}

export function respondAcpPermission(
  chatId: string,
  requestKey: string,
  optionId: string | null,
): Promise<void> {
  return call("respond_acp_permission", {
    chatId,
    requestKey,
    optionId: optionId ?? undefined,
  });
}

export function getAcpChat(chatId: string): Promise<AcpChatSnapshot | null> {
  return call("get_acp_chat", { chatId });
}

export function stopAcpChat(chatId: string): Promise<void> {
  return call("stop_acp_chat", { chatId });
}

export type AgentChatEventHandler = (event: AcpChatEvent) => void | Promise<void>;

export async function listenAgentChatEvents(
  handler: AgentChatEventHandler,
): Promise<UnlistenFn> {
  requireDesktop();
  return listenIfTauri<AcpChatEvent>(ACP_CHAT_EVENT, (event) => handler(event.payload));
}

/** ACP chat transport（结构化 agent 对话标签）。终端启动不走这里。 */
export const agentChatService = {
  listEngines: listAcpEngines,
  start: startAcpChat,
  prompt: promptAcpChat,
  cancel: cancelAcpChat,
  respondPermission: respondAcpPermission,
  get: getAcpChat,
  stop: stopAcpChat,
  listen: listenAgentChatEvents,
};
