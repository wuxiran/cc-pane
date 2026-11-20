import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, listenIfTauri } from "./runtime";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { BOTS_CHANGED_EVENT, type Bot, type BotSummary } from "@/types/bot";

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
  listenChanged: (handler: () => void): Promise<UnlistenFn> =>
    listenIfTauri(BOTS_CHANGED_EVENT, () => handler()),
};
