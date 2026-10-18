import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { entryForTurn, type ChatTimelineEntry } from "./chatTimeline";

interface Options {
  entries: ChatTimelineEntry[];
  scrollRef: RefObject<HTMLDivElement | null>;
  visibleCount: number;
  onReveal: (turnIndex: number) => void;
  onNavigate: () => void;
}

/** Uses the chat's own scroll container; jumping never scrolls the whole app. */
export function useChatTimelineNavigation({ entries, scrollRef, visibleCount, onReveal, onNavigate }: Options) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const frame = useRef<number | null>(null);

  const updateActive = useCallback(() => {
    const root = scrollRef.current;
    if (!root || !entries.length) return;
    if (root.scrollHeight - root.scrollTop - root.clientHeight < 48) {
      setActiveId(entries[entries.length - 1].id);
      return;
    }
    const anchor = root.getBoundingClientRect().top + Math.min(96, root.clientHeight / 4);
    let index: number | undefined;
    for (const element of root.querySelectorAll<HTMLElement>("[data-chat-turn-index]")) {
      if (index !== undefined && element.getBoundingClientRect().top > anchor) break;
      index = Number(element.dataset.chatTurnIndex);
    }
    if (index !== undefined) setActiveId(entryForTurn(entries, index));
  }, [entries, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const schedule = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        updateActive();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    root.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      root.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scrollRef, updateActive, visibleCount]);

  useLayoutEffect(() => {
    if (!pendingId) return;
    const root = scrollRef.current;
    const target = Array.from(root?.querySelectorAll<HTMLElement>("[data-chat-turn-id]") ?? [])
      .find((element) => element.dataset.chatTurnId === pendingId);
    if (!root || !target) return;
    root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 12;
    setActiveId(pendingId);
    setPendingId(null);
  }, [pendingId, visibleCount, entries, scrollRef]);

  const jumpToEntry = useCallback((entry: ChatTimelineEntry) => {
    onNavigate();
    onReveal(entry.turnIndex);
    setPendingId(entry.id);
  }, [onNavigate, onReveal]);

  return { activeId: activeId ?? entries[entries.length - 1]?.id ?? null, jumpToEntry };
}
