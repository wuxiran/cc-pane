import { emitTo } from "@tauri-apps/api/event";
import { useMemo } from "react";
import { useTerminalStatusStore } from "@/stores";
import type { TerminalStatusInfo, TerminalStatusType } from "@/types";

const STATUS_COLORS: Record<TerminalStatusType, string> = {
  initializing: "#8e8e93",
  idle: "#8e8e93",
  thinking: "#30d158",
  toolRunning: "#30d158",
  compacting: "#0a84ff",
  waitingInput: "#ffd60a",
  error: "#ff453a",
  exited: "#48484a",
  active: "#30d158",
};

const VISIBLE_DOT_STATUSES: ReadonlySet<TerminalStatusType> = new Set([
  "initializing",
  "thinking",
  "toolRunning",
  "compacting",
  "waitingInput",
  "error",
  "active",
]);

function getDotTitle(info: TerminalStatusInfo) {
  const tool = info.currentToolName ? ` · ${info.currentToolName}` : "";
  return `${info.sessionId} · ${info.status}${tool}`;
}

export function visibleSessionDots(statuses: TerminalStatusInfo[]) {
  return statuses
    .filter((info) => VISIBLE_DOT_STATUSES.has(info.status))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export function SessionDots() {
  const statusMap = useTerminalStatusStore((state) => state.statusMap);
  const dots = useMemo(
    () => visibleSessionDots(Array.from(statusMap.values())),
    [statusMap],
  );

  if (dots.length === 0) return null;

  return (
    <div className="flex max-w-[58px] flex-wrap justify-center gap-1 px-1">
      {dots.map((info) => (
        <button
          key={info.sessionId}
          type="button"
          aria-label={`Focus session ${info.sessionId}`}
          title={getDotTitle(info)}
          className="h-2.5 w-2.5 rounded-full border border-black/25 p-0 shadow-sm transition-transform hover:scale-125"
          style={{ backgroundColor: STATUS_COLORS[info.status] ?? "#6e6e73" }}
          onClick={(event) => {
            event.stopPropagation();
            void emitTo("main", "ccchan:focus-session", { sessionId: info.sessionId });
          }}
        />
      ))}
    </div>
  );
}
