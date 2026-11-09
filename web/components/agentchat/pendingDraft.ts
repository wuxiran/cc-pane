// 「预填到启动页输入框」的一次性交接（不自动发送）：右侧面板 Git 视图的「让对话审阅」
// 等入口把一段 prompt 塞进某个对话的启动页，用户确认引擎后自己按发送。
// 与 pendingStart 同构（模块级 Map 按 chatId 暂存），额外带订阅：目标启动页可能已挂着。
import { useEffect, type RefObject } from "react";

const pending = new Map<string, string>();
const listeners = new Set<(chatId: string) => void>();

export function setPendingDraft(chatId: string, text: string): void {
  pending.set(chatId, text);
  listeners.forEach((listener) => listener(chatId));
}

export function takePendingDraft(chatId: string): string | null {
  const text = pending.get(chatId) ?? null;
  pending.delete(chatId);
  return text;
}

/** 启动页挂载时、以及挂着期间有人投递时，领取预填文本并聚焦输入框。 */
export function usePendingDraft(
  chatId: string,
  setDraft: (text: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): void {
  useEffect(() => {
    const apply = () => {
      const text = takePendingDraft(chatId);
      if (text === null) return;
      setDraft(text);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(text.length, text.length);
      });
    };
    apply();
    const listener = (target: string) => {
      if (target === chatId) apply();
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [chatId, setDraft, textareaRef]);
}
