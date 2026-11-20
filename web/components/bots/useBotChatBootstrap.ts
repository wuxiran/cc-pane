// Bot 标签的启动：不走引擎选择页，直接按 Bot 记住的线程拉起（后端 start_bot_chat）。
// 「开新话题」会清掉 store 里的会话，快照消失后这里自动重新拉起一条新线程。
import { useCallback, useEffect, useRef, useState } from "react";
import { botService } from "@/services/botService";
import { ensureAgentChatListener } from "@/stores/agentChatEvents";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

export interface BotChatBootstrap {
  starting: boolean;
  error: string | null;
  start: () => void;
}

export function useBotChatBootstrap(chatId: string, botId: string | null): BotChatBootstrap {
  const hasSnapshot = useAgentChatStore((state) => Boolean(state.chats[chatId]?.snapshot));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const start = useCallback(() => {
    if (!botId || inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    // 续接回放的 history_replay 事件在 start 返回前就会到，监听必须先就位。
    ensureAgentChatListener();
    botService
      .start(botId)
      .then((snapshot) => useAgentChatStore.getState().setSnapshot(chatId, snapshot))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        inFlight.current = false;
        setStarting(false);
      });
  }, [botId, chatId]);

  useEffect(() => {
    if (botId && !hasSnapshot) start();
  }, [botId, hasSnapshot, start]);

  return { starting, error, start };
}
