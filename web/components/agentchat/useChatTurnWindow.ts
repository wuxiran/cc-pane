import { useCallback, useState, type SetStateAction } from "react";

/** Keep the oldest rendered turn while reading history. Growing a fixed tail
 * window would otherwise remove that turn as soon as a new message arrives. */
export function useChatTurnWindow(turns: readonly { id: string }[], readingHistory: boolean) {
  const [window, setWindow] = useState(() => ({ ids: turns.map((turn) => turn.id), count: 60 }));
  let visibleCount = window.count;
  const changed = turns.length !== window.ids.length
    || turns.some((turn, index) => turn.id !== window.ids[index]);
  if (changed) {
    const anchorId = window.ids[Math.max(0, window.ids.length - window.count)];
    const anchorIndex = anchorId === undefined ? -1 : turns.findIndex((turn) => turn.id === anchorId);
    // Prepending older history leaves the window size unchanged. A replay with
    // regenerated ids keeps the user's current window size instead of treating
    // replacement history as newly appended messages.
    if (readingHistory && anchorIndex >= 0) visibleCount = Math.max(window.count, turns.length - anchorIndex);
    setWindow({ ids: turns.map((turn) => turn.id), count: visibleCount });
  }
  const setVisibleCount = useCallback((action: SetStateAction<number>) => {
    setWindow((previous) => ({
      ...previous,
      count: typeof action === "function" ? action(previous.count) : action,
    }));
  }, []);
  return [visibleCount, setVisibleCount] as const;
}
