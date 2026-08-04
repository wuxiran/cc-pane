import { useEffect } from "react";
import { useActiveTerminalContext } from "./useActiveTerminalSession";
import { useContextUsageStore } from "@/stores/useContextUsageStore";

const POLL_INTERVAL_MS = 10_000;

export function useContextUsagePoller(): string | null {
  const active = useActiveTerminalContext();
  const cliTool = active?.cliTool;
  const supported = Boolean(
    active?.sessionId
      && !active.ssh
      && (cliTool === "claude" || cliTool === "codex"),
  );
  const sessionId = supported ? active?.sessionId ?? null : null;
  const setSession = useContextUsageStore((state) => state.setSession);
  const load = useContextUsageStore((state) => state.load);

  useEffect(() => {
    setSession(sessionId);
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      if (!cancelled && !document.hidden) void load(sessionId);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer !== null || document.hidden) return;
      refresh();
      timer = setInterval(refresh, POLL_INTERVAL_MS);
    };
    const onVisibilityChange = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibilityChange);
    start();
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load, sessionId, setSession]);

  return sessionId;
}
