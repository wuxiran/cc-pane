export type TerminalWheelMode =
  | "browser-history"
  | "alternate-app"
  | "xterm-default";

export interface TerminalWheelState {
  bufferType: "normal" | "alternate" | "unknown";
  baseY: number;
}

export function resolveTerminalWheelMode(state: TerminalWheelState): TerminalWheelMode {
  if (state.bufferType === "alternate") return "alternate-app";
  if (state.bufferType === "normal" && state.baseY > 0) return "browser-history";
  return "xterm-default";
}
