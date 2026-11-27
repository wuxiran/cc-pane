// `@Bot` 委托的动作层：加载补全目录、发起 / 取消委托、打开 Bot 对话。
// 状态全在 useBotAskStore；这里只做 invoke 编排（桌面端独有，Web 壳下目录为空）。
import { botService } from "@/services/botService";
import { listAcpEngines } from "@/services/agentChatService";
import { isTauriRuntime } from "@/services/runtime";
import { ensureAgentChatListener } from "@/stores/agentChatEvents";
import { useBotAskStore, type BotAskTarget, type BotMention } from "@/stores/useBotAskStore";
import type { Bot } from "@/types/bot";
import { getErrorCode, translateError } from "@/utils/errorTranslation";
import { handleErrorSilent } from "@/utils/errorHandler";
import { openBotChat } from "@/components/bots/openBotChat";

let directoryRequested = false;
let unlistenChanged: (() => void) | null = null;

async function reloadBots(): Promise<void> {
  try {
    useBotAskStore.getState().setBots(await botService.list());
  } catch (error) {
    handleErrorSilent(error, "list bots for mention");
  }
}

/** 首次 `@` 时加载一次 Bot 与引擎目录，并跟随 `bots-changed` 刷新 Bot 列表。 */
export function ensureBotDirectory(): void {
  if (directoryRequested) return;
  directoryRequested = true;
  const store = useBotAskStore.getState();
  if (!isTauriRuntime()) {
    store.setBots([]);
    store.setEngines([]);
    return;
  }
  void reloadBots();
  listAcpEngines()
    .then((engines) => useBotAskStore.getState().setEngines(Array.isArray(engines) ? engines : []))
    .catch((error) => {
      handleErrorSilent(error, "list acp engines for mention");
      useBotAskStore.getState().setEngines([]);
    });
  void botService
    .listenChanged(() => void reloadBots())
    .then((unlisten) => {
      unlistenChanged = unlisten;
    })
    .catch((error) => handleErrorSilent(error, "listen bots changed"));
}

/** 测试用：重置模块级加载标记。 */
export function resetBotDirectoryForTest(): void {
  directoryRequested = false;
  unlistenChanged?.();
  unlistenChanged = null;
}

function targetOf(bot: Pick<Bot, "name" | "avatar" | "color">): BotAskTarget {
  return { name: bot.name, avatar: bot.avatar, color: bot.color };
}

type BotIdentity = Pick<Bot, "id" | "name" | "avatar" | "color">;

async function resolveBot(mention: BotMention, cwd: string): Promise<BotIdentity> {
  if (mention.kind === "engine") {
    const bot = await botService.ensureEngineBot(mention.engineId, cwd || null);
    void reloadBots();
    return bot;
  }
  const known = useBotAskStore.getState().bots?.find((bot) => bot.id === mention.botId);
  if (known) return known;
  return { id: mention.botId, name: mention.name, avatar: "", color: "" };
}

/** 发起一次委托：立即插卡片，后台排队等 Bot 回复。返回卡片 id。 */
export function askBot({ fromChatId, cwd, mention, text }: {
  fromChatId: string;
  cwd: string;
  mention: BotMention;
  text: string;
}): string {
  const askId = crypto.randomUUID();
  const store = useBotAskStore.getState();
  const known = mention.kind === "bot" ? store.bots?.find((bot) => bot.id === mention.botId) : undefined;
  store.start({
    id: askId,
    fromChatId,
    text,
    target: known ? targetOf(known) : { name: mention.name, avatar: "", color: "" },
    botId: mention.kind === "bot" ? mention.botId : null,
  });
  // Bot 对话的阶段（启动 / 回复 / 审批）从全局 ACP 事件里读。
  ensureAgentChatListener();
  void runAsk(askId, fromChatId, cwd, mention, text);
  return askId;
}

async function runAsk(askId: string, fromChatId: string, cwd: string, mention: BotMention, text: string): Promise<void> {
  const store = useBotAskStore.getState;
  try {
    const bot = await resolveBot(mention, cwd);
    store().bindBot(askId, bot.id, targetOf(bot));
    // 准备阶段就被取消了：不再发出。
    if (store().asks[askId]?.cancelRequested) {
      store().finish(askId, "", true);
      return;
    }
    const reply = await botService.ask(askId, bot.id, text, fromChatId);
    store().finish(askId, reply.text, reply.stopReason === "cancelled");
  } catch (error) {
    if (getErrorCode(error) === "BOT_ASK_CANCELLED") store().finish(askId, "", true);
    else store().fail(askId, translateError(error));
  }
}

export function cancelBotAsk(askId: string): void {
  const store = useBotAskStore.getState();
  const ask = store.asks[askId];
  if (!ask || ask.status !== "running") return;
  store.requestCancel(askId);
  if (!ask.botId) return; // 还在找 / 建默认 Bot，runAsk 会在发出前看到取消标记。
  void sendCancel(askId, CANCEL_RETRIES);
}

const CANCEL_RETRIES = 5;
const CANCEL_RETRY_MS = 200;

/** 后端还没登记这条（invoke 在路上）时会返回 false：稍后重试，直到它结束或登记上。 */
async function sendCancel(askId: string, attempts: number): Promise<void> {
  try {
    const accepted = await botService.cancelAsk(askId);
    const running = useBotAskStore.getState().asks[askId]?.status === "running";
    if (!accepted && running && attempts > 1) {
      setTimeout(() => void sendCancel(askId, attempts - 1), CANCEL_RETRY_MS);
    }
  } catch (error) {
    handleErrorSilent(error, "cancel bot ask");
  }
}

/** 打开委托对应的 Bot 对话（审批、看完整过程都在那里）。 */
export async function openAskBotChat(askId: string): Promise<void> {
  const botId = useBotAskStore.getState().asks[askId]?.botId;
  if (!botId) return;
  let summary = useBotAskStore.getState().bots?.find((bot) => bot.id === botId);
  if (!summary) {
    await reloadBots();
    summary = useBotAskStore.getState().bots?.find((bot) => bot.id === botId);
  }
  if (summary) openBotChat(summary);
}
