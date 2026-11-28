// 当前 Bot：联系人列表 + 选中哪个 + 它的对话相位。
//
// 宠物窗口不挂完整的 Agent Chat 事件桥（那会把所有会话的消息流都装进这个
// 小窗口），只订阅同一条 `acp-chat-event` 广播，按 chatId 过滤出当前 Bot，
// 推进相位 / 待审批数 / 出错标记三个字段。
import { useEffect, useMemo, useState } from "react";
import { agentChatService } from "@/services/agentChatService";
import { botService } from "@/services/botService";
import { isTauriRuntime } from "@/services/runtime";
import type { AcpChatEvent, AcpChatSnapshot } from "@/types/agentChat";
import { botChatId, type BotSummary } from "@/types/bot";
import { IDLE_BOT_STATE, type BotPetState } from "./petStatus";

interface TrackedBotState extends BotPetState {
  requestKeys: readonly string[];
}

export const EMPTY_TRACKED: TrackedBotState = { ...IDLE_BOT_STATE, requestKeys: [] };

/** 单条 ACP 事件推进 Bot 状态（纯函数）。 */
export function reduceBotEvent(state: TrackedBotState, event: AcpChatEvent): TrackedBotState {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const key = typeof payload.requestKey === "string" ? payload.requestKey : null;
  switch (event.kind) {
    case "state": {
      const phase = (payload as unknown as AcpChatSnapshot).phase ?? null;
      const clears = phase === "starting" || phase === "exited" || phase === "failed";
      const requestKeys = clears ? [] : state.requestKeys;
      // 新一轮开始生成：上一轮的错误作废。
      const error = phase === "generating" ? false : state.error;
      return { phase, error, requestKeys, pendingRequests: requestKeys.length };
    }
    case "permission_request":
    case "elicitation_request": {
      if (!key || state.requestKeys.includes(key)) return state;
      const requestKeys = [...state.requestKeys, key];
      return { ...state, requestKeys, pendingRequests: requestKeys.length };
    }
    case "permission_resolved":
    case "elicitation_cancelled": {
      if (!key) return state;
      const requestKeys = state.requestKeys.filter((item) => item !== key);
      return { ...state, requestKeys, pendingRequests: requestKeys.length };
    }
    case "turn_ended": {
      const error = typeof payload.error === "string" && payload.error.length > 0;
      return { ...state, error, requestKeys: [], pendingRequests: 0 };
    }
    default:
      return state;
  }
}

/** 选中的 Bot：设置里记住的那个；已删除 / 未设置时退回第一个；没有 Bot 返回 null。 */
export function pickActiveBot(bots: readonly BotSummary[], activeBotId: string | null | undefined): BotSummary | null {
  return bots.find((bot) => bot.id === activeBotId) ?? bots[0] ?? null;
}

export function useBotPet(activeBotId: string | null | undefined) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [tracked, setTracked] = useState<TrackedBotState>(EMPTY_TRACKED);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const reload = () => {
      botService.list().then((list) => { if (!disposed) setBots(list); })
        .catch((error: unknown) => console.warn("[ccchan] list bots:", error));
    };
    reload();
    void botService.listenChanged(reload).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const activeBot = useMemo(() => pickActiveBot(bots, activeBotId), [bots, activeBotId]);
  const chatId = activeBot ? botChatId(activeBot.id) : null;

  useEffect(() => {
    setTracked(EMPTY_TRACKED);
    if (!chatId || !isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void agentChatService.get(chatId).then((snapshot) => {
      if (disposed || !snapshot) return;
      setTracked((state) => reduceBotEvent(state, { chatId, kind: "state", payload: snapshot }));
    }).catch(() => {});
    void agentChatService.listen((event) => {
      if (event.chatId !== chatId) return;
      setTracked((state) => reduceBotEvent(state, event));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch((error: unknown) => console.warn("[ccchan] listen bot chat:", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [chatId]);

  const botState: BotPetState = {
    phase: tracked.phase,
    pendingRequests: tracked.pendingRequests,
    error: tracked.error,
  };
  return { bots, activeBot, botState };
}
