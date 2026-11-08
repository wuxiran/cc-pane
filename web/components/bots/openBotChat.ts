// 打开 Bot 对话：标签 id 固定为 `bot-{id}`，已开着就切过去，绝不重复开。
import { useActivityBarStore, usePanesStore } from "@/stores";
import { botChatId, type BotSummary } from "@/types/bot";

export function openBotChat(bot: Pick<BotSummary, "id" | "name" | "engineId" | "effectiveCwd">): void {
  const tabId = botChatId(bot.id);
  const store = usePanesStore.getState();
  const found = store.findTabAcrossLayouts(tabId);
  if (found) {
    if (store.currentLayoutId !== found.layoutId) store.switchLayout(found.layoutId);
    usePanesStore.getState().selectTab(found.panel.id, tabId);
  } else {
    store.openAgentChat(bot.effectiveCwd, { tabId, engineId: bot.engineId, title: bot.name });
  }
  useActivityBarStore.getState().setAppViewMode("panes");
}
