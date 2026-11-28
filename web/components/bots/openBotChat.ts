// 打开 Bot 对话：标签 id 固定为 `bot-{id}`，已开着就切过去，绝不重复开。
import { useActivityBarStore, usePanesStore } from "@/stores";
import { botChatId, CREATE_BOT_DOM_EVENT, type BotSummary } from "@/types/bot";

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

// 桌宠「新建 Bot」：联系人视图可能还没挂载（刚切过去），先记下请求，
// 挂载时消费；已挂载的视图经 DOM 事件立即响应。
let pendingCreate = false;

export function requestBotCreate(): void {
  pendingCreate = true;
  window.dispatchEvent(new Event(CREATE_BOT_DOM_EVENT));
}

export function consumeBotCreateRequest(): boolean {
  const pending = pendingCreate;
  pendingCreate = false;
  return pending;
}
