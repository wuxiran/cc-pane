import type { Terminal } from "@xterm/xterm";

import { terminalService } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";

interface RefValue<T> {
  current: T;
}

interface ReconnectTerminalSessionOptions {
  terminalInstanceRef: RefValue<Terminal | null>;
  isReconnectingRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
  currentSessionIdRef: RefValue<string | null>;
  onReconnectRef: RefValue<(() => Promise<string | null>) | null | undefined>;
  unbindSessionCallbacks: () => void;
  bindSessionCallbacks: (sessionId: string) => Promise<void>;
}

/** SSH 会话断线重连（从 TerminalView 抽出，行数棘轮）。 */
export async function reconnectTerminalSession({
  terminalInstanceRef,
  isReconnectingRef,
  isDisconnectedRef,
  currentSessionIdRef,
  onReconnectRef,
  unbindSessionCallbacks,
  bindSessionCallbacks,
}: ReconnectTerminalSessionOptions): Promise<void> {
  const term = terminalInstanceRef.current;
  if (!term || isReconnectingRef.current) return;
  const onReconnect = onReconnectRef.current;
  if (!onReconnect) return;

  isReconnectingRef.current = true;
  term.writeln("\r\n\x1b[33mReconnecting...\x1b[0m");

  try {
    // Detach callbacks from the previous session before reconnecting.
    unbindSessionCallbacks();

    const newSessionId = await onReconnect();
    if (!newSessionId) {
      term.writeln("\x1b[31mReconnection failed.\x1b[0m");
      term.writeln("\x1b[36mPress Enter to retry.\x1b[0m");
      isReconnectingRef.current = false;
      return;
    }

    currentSessionIdRef.current = newSessionId;
    term.writeln("\r\n\x1b[32m--- Reconnected ---\x1b[0m\r\n");

    // Attach callbacks to the new session.
    await bindSessionCallbacks(newSessionId);

    // Keep the backend PTY size aligned with the current terminal size.
    terminalService.resize({
      sessionId: newSessionId,
      cols: term.cols,
      rows: term.rows,
    });

    isDisconnectedRef.current = false;
    isReconnectingRef.current = false;
  } catch (error) {
    console.error("[TerminalView] Reconnection failed:", error);
    term.writeln(`\r\n\x1b[31mReconnection failed: ${getErrorMessage(error)}\x1b[0m`);
    term.writeln("\x1b[36mPress Enter to retry.\x1b[0m");
    isReconnectingRef.current = false;
  }
}
