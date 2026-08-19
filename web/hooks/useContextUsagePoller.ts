import { useEffect } from "react";
import {
  useActiveTerminalContext,
  type ActiveTerminalContext,
} from "./useActiveTerminalSession";
import { useContextUsageStore } from "@/stores/useContextUsageStore";

const POLL_INTERVAL_MS = 10_000;

export function useContextUsagePoller(
  terminalContext?: ActiveTerminalContext | null,
  enabled = true,
): string | null {
  const active = useActiveTerminalContext();
  const terminal = terminalContext === undefined ? active : terminalContext;
  const followsActiveTerminal = terminalContext === undefined;
  const cliTool = terminal?.cliTool;
  const supported = Boolean(
    terminal?.sessionId
      && !terminal.ssh
      && (cliTool === "claude" || cliTool === "codex" || cliTool === "pi" || cliTool === "omp"),
  );
  const sessionId = supported ? terminal?.sessionId ?? null : null;
  const setSession = useContextUsageStore((state) => state.setSession);
  const loadSession = useContextUsageStore((state) => state.loadSession);

  useEffect(() => {
    if (followsActiveTerminal) setSession(sessionId);
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      if (!cancelled && !document.hidden) void loadSession(sessionId);
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
  }, [enabled, followsActiveTerminal, loadSession, sessionId, setSession]);

  return sessionId;
}
