import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, listenIfTauri } from "./runtime";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { BOTS_CHANGED_EVENT, type Bot, type BotAskReply, type BotSummary } from "@/types/bot";

/** Bot 只在桌面端存在（会话进程在 Tauri 侧）；Web 壳下列表为空。 */
async function listBots(): Promise<BotSummary[]> {
  if (!isTauriRuntime()) return [];
  const list = await invoke<BotSummary[] | null>("list_bots");
  return Array.isArray(list) ? list : [];
}

export const botService = {
  list: listBots,
  save: async (bot: Bot): Promise<Bot> => invoke("save_bot", { bot }),
  remove: async (botId: string): Promise<void> => invoke("delete_bot", { botId }),
  /** 按 Bot 记住的线程拉起（已在跑直接返回快照）。 */
  start: async (botId: string): Promise<AcpChatSnapshot> => invoke("start_bot_chat", { botId }),
  /** 开新话题：停掉进程并忘掉线程，下次 start 是全新会话。 */
  newThread: async (botId: string): Promise<Bot> => invoke("new_bot_thread", { botId }),
  /** Agent Chat 里的 `@Bot`：排队等 Bot 空闲、跑完一轮后返回回复（可能很久）。 */
  ask: async (askId: string, botId: string, text: string, fromChatId: string): Promise<BotAskReply> =>
    invoke("ask_bot", { askId, botId, text, fromChatId }),
  /** 取消在途的 `@Bot` 请求；已结束返回 false。 */
  cancelAsk: async (askId: string): Promise<boolean> => invoke("cancel_bot_ask", { askId }),
  /** 「@引擎」：找到或创建该引擎在该 cwd 下的默认 Bot。 */
  ensureEngineBot: async (engineId: string, cwd: string | null): Promise<Bot> =>
    invoke("ensure_engine_bot", { engineId, cwd }),
  listenChanged: (handler: () => void): Promise<UnlistenFn> =>
    listenIfTauri(BOTS_CHANGED_EVENT, () => handler()),
};
