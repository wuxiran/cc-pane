import { useEffect, useState } from "react";
import { magpieService } from "@/services/magpieService";
import type { MagpieRouteStatus } from "@/types/magpie";

/** 每次长轮询在网关上最多挂多久（秒）；后端再夹到 25s。 */
export const MAGPIE_ROUTE_LONG_POLL_SECS = 20;
/** 两次请求之间的最小间隔：网关立刻返回（重启、seq 回退）时不打成热循环。 */
export const MAGPIE_ROUTE_MIN_GAP_MS = 1_000;
/** 不可用（Magpie 没开 / 会话不走 Magpie）时的低频重试。 */
export const MAGPIE_ROUTE_OFFLINE_RETRY_MS = 60_000;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * 跟踪会话在 Magpie 上的路由：先查一次拿 seq，之后用 `after=seq&wait=` 长轮询，
 * 路由一变就返回。`enabled` 为 false（会话不可见）或页面隐藏时停；不可用时低频重试并返回 null。
 */
export function useMagpieSessionRoute(
  sessionId: string | null,
  enabled: boolean,
): MagpieRouteStatus | null {
  const [status, setStatus] = useState<MagpieRouteStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq: number | null = null;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled || running || pageHidden()) return;
      running = true;
      const result = seq === null
        ? await magpieService.getSessionRoute(sessionId)
        : await magpieService.getSessionRoute(sessionId, seq, MAGPIE_ROUTE_LONG_POLL_SECS);
      running = false;
      if (cancelled) return;
      if (!result.available) {
        seq = null;
        setStatus(null);
        schedule(MAGPIE_ROUTE_OFFLINE_RETRY_MS);
        return;
      }
      seq = result.seq;
      setStatus(result);
      schedule(MAGPIE_ROUTE_MIN_GAP_MS);
    };

    const onVisibilityChange = () => {
      if (pageHidden() || timer !== null) return;
      void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, sessionId]);

  return status;
}
