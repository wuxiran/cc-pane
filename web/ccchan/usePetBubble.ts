// 宠物气泡：单行提问输入 → 等待 → 单次回复 / 出错；外加 MCP `ccchan_say`
// 与会话事件的短提示。不保留历史、不做多轮对话 UI——完整线程在主窗口联系人里。
//
// 提问走 Bot 现有的 `ask_bot` 通路（与 Agent Chat 里 @Bot 同一个）：仍是
// `bot-{id}` 那条长期线程，回合在主窗口的 Bot 对话里完整可见。
import { useCallback, useEffect, useRef, useState } from "react";
import { botService } from "@/services/botService";
import { getErrorMessage } from "@/utils";

/** `ask_bot` 的来源 chatId：宠物不是一个 chat 标签，用固定标识。 */
export const PET_FROM_CHAT_ID = "ccchan-pet";

export type PetBubble =
  | { kind: "input" }
  | { kind: "pending"; askId: string; question: string }
  | { kind: "reply"; text: string; botChatId: string }
  | { kind: "error"; message: string }
  | { kind: "notice"; text: string; durationMs: number };

const REPLY_MIN_MS = 8_000;
const REPLY_MAX_MS = 20_000;

export function replyDurationMs(text: string): number {
  return Math.min(REPLY_MAX_MS, REPLY_MIN_MS + text.length * 40);
}

function newAskId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `pet-${random}`.slice(0, 64);
}

export function usePetBubble(botId: string | null, cancelledText: string) {
  const [bubble, setBubble] = useState<PetBubble | null>(null);
  const bubbleRef = useRef<PetBubble | null>(null);
  bubbleRef.current = bubble;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback((next: PetBubble | null, durationMs?: number) => {
    clearTimer();
    setBubble(next);
    if (next && durationMs) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setBubble((current) => (current === next ? null : current));
      }, durationMs);
    }
  }, []);

  useEffect(() => clearTimer, []);

  const busy = bubble?.kind === "input" || bubble?.kind === "pending";

  const openInput = useCallback(() => {
    if (bubbleRef.current?.kind === "pending") return;
    show({ kind: "input" });
  }, [show]);

  const dismiss = useCallback(() => {
    if (bubbleRef.current?.kind === "pending") return;
    show(null);
  }, [show]);

  /** 短提示（MCP say / 会话事件）：不打断输入与等待中的回复。 */
  const notify = useCallback((text: string, durationMs: number) => {
    const current = bubbleRef.current?.kind;
    if (current === "input" || current === "pending") return;
    const next: PetBubble = { kind: "notice", text, durationMs };
    show(next, durationMs);
  }, [show]);

  const submit = useCallback((raw: string) => {
    const question = raw.trim();
    if (!question || !botId) return;
    const askId = newAskId();
    show({ kind: "pending", askId, question });
    botService
      .ask(askId, botId, question, PET_FROM_CHAT_ID)
      .then((reply) => {
        const current = bubbleRef.current;
        if (current?.kind !== "pending" || current.askId !== askId) return;
        const text = reply.text.trim();
        if (!text && reply.stopReason === "cancelled") {
          show({ kind: "error", message: cancelledText }, 4_000);
          return;
        }
        const next: PetBubble = { kind: "reply", text, botChatId: reply.botChatId };
        show(next, replyDurationMs(text));
      })
      .catch((error: unknown) => {
        const current = bubbleRef.current;
        if (current?.kind !== "pending" || current.askId !== askId) return;
        show({ kind: "error", message: getErrorMessage(error) }, 6_000);
      });
  }, [botId, cancelledText, show]);

  const cancel = useCallback(() => {
    const current = bubbleRef.current;
    if (current?.kind !== "pending") return;
    void botService.cancelAsk(current.askId).catch(() => {});
    show({ kind: "error", message: cancelledText }, 3_000);
  }, [cancelledText, show]);

  return { bubble, busy, openInput, dismiss, notify, submit, cancel };
}
