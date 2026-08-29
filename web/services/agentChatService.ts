import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, listenIfTauri } from "./runtime";
import type { DiffResult } from "./localHistoryService";
import type {
  AcpChatEvent,
  AcpChatHistoryEntry,
  AcpChatSnapshot,
  AcpEngineInfo,
} from "@/types/agentChat";

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
  resumeAcpSessionId?: string,
): Promise<AcpChatSnapshot> {
  return call("start_acp_chat", { chatId, engineId, cwd, resumeAcpSessionId });
}

/** blocks 为 ACP ContentBlock 数组（text / image / resource_link）。 */
export function promptAcpChat(chatId: string, blocks: unknown[]): Promise<void> {
  return call("prompt_acp_chat", { chatId, blocks });
}

export function listAcpChatHistory(): Promise<AcpChatHistoryEntry[]> {
  return call("list_acp_chat_history");
}

/** 行级文本 diff（复用 Local History diff 引擎）。 */
export function computeTextDiff(oldText: string, newText: string): Promise<DiffResult> {
  return call("compute_text_diff", { oldText, newText });
}

export interface AcpImageAttachmentContent {
  path: string;
  dataBase64: string;
  mimeType: string;
  size: number;
}

/** 读本地图片为 base64（附件按钮用；扩展名白名单 + 10MB 上限在后端）。 */
export function readAcpImageAttachment(path: string): Promise<AcpImageAttachmentContent> {
  return call("read_acp_image_attachment", { path });
}

export function cancelAcpChat(chatId: string): Promise<void> {
  return call("cancel_acp_chat", { chatId });
}

export function setAcpChatMode(chatId: string, modeId: string): Promise<void> {
  return call("set_acp_chat_mode", { chatId, modeId });
}

export function setAcpChatModel(chatId: string, modelId: string): Promise<void> {
  return call("set_acp_chat_model", { chatId, modelId });
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
  setMode: setAcpChatMode,
  setModel: setAcpChatModel,
  respondPermission: respondAcpPermission,
  get: getAcpChat,
  stop: stopAcpChat,
  listHistory: listAcpChatHistory,
  computeTextDiff,
  readImageAttachment: readAcpImageAttachment,
  listen: listenAgentChatEvents,
};
