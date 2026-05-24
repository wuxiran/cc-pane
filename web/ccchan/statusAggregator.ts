import type { TerminalStatusType } from "@/types";
import type { CCChanPetState } from "./types";

const WORKING_STATUSES: ReadonlySet<TerminalStatusType> = new Set([
  "toolRunning",
  "compacting",
  "active",
  "initializing",
]);

// 优先级: sad(error) > waiting > thinking > working > idle
export function aggregateStatus(statuses: TerminalStatusType[]): CCChanPetState {
  if (statuses.some((status) => status === "error")) return "sad";
  if (statuses.some((status) => status === "waitingInput")) return "waiting";
  if (statuses.some((status) => status === "thinking")) return "thinking";
  if (statuses.some((status) => WORKING_STATUSES.has(status))) return "working";
  return "idle";
}
