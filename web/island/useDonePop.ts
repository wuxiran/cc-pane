import { useEffect, useRef, useState } from "react";
import type { IslandSession } from "@/types/island";

export const DONE_POP_MS = 4_000;

const keyOf = (session: IslandSession) => `${session.id}:${session.since}`;

/**
 * 新出现的「刚完成」在收起态弹 4 秒后自动缩回。岛刚加载时已有的完成记录不弹
 * （那是历史，不是「刚刚」）。关闭开关时永远不弹。
 */
export function useDonePop(done: readonly IslandSession[], enabled: boolean): IslandSession | null {
  const seen = useRef<Set<string> | null>(null);
  const [pop, setPop] = useState<IslandSession | null>(null);

  useEffect(() => {
    const keys = new Set(done.map(keyOf));
    if (seen.current === null) {
      seen.current = keys;
      return;
    }
    const fresh = done.find((session) => !seen.current?.has(keyOf(session)));
    seen.current = keys;
    if (fresh && enabled) setPop(fresh);
  }, [done, enabled]);

  useEffect(() => {
    if (!pop) return undefined;
    const timer = setTimeout(() => setPop(null), DONE_POP_MS);
    return () => clearTimeout(timer);
  }, [pop]);

  return enabled ? pop : null;
}
