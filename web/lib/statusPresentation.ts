import type { TerminalStatusType } from "@/types";

export type StatusLabelKey =
  | "statusInitializing"
  | "statusIdle"
  | "statusThinking"
  | "statusToolRunning"
  | "statusCompacting"
  | "statusWaitingInput"
  | "statusError"
  | "statusExited"
  | "statusActive";

export type StatusPresentationShape = "circle" | "diamond" | "triangle";

export interface StatusPresentation {
  colorToken: string;
  pulsing: boolean;
  labelKey: StatusLabelKey;
  severityRank: number;
  shape?: StatusPresentationShape;
  filled?: boolean;
}

export const DEFAULT_STATUS_COLOR_TOKEN = "var(--app-text-tertiary)";

export const TERMINAL_STATUS_TYPES = [
  "initializing",
  "idle",
  "thinking",
  "toolRunning",
  "compacting",
  "waitingInput",
  "error",
  "exited",
  "active",
] as const satisfies readonly TerminalStatusType[];

export const UNKNOWN_STATUS_SEVERITY_RANK = TERMINAL_STATUS_TYPES.length;

export const TERMINAL_STATUS_PRESENTATION = {
  error: {
    colorToken: "var(--app-status-danger)",
    pulsing: false,
    labelKey: "statusError",
    severityRank: 0,
    shape: "triangle",
    filled: true,
  },
  waitingInput: {
    colorToken: "var(--app-status-warning)",
    pulsing: false,
    labelKey: "statusWaitingInput",
    severityRank: 1,
    shape: "diamond",
    filled: true,
  },
  compacting: {
    colorToken: "var(--app-accent)",
    pulsing: true,
    labelKey: "statusCompacting",
    severityRank: 2,
    shape: "circle",
    filled: true,
  },
  toolRunning: {
    colorToken: "var(--app-accent)",
    pulsing: true,
    labelKey: "statusToolRunning",
    severityRank: 3,
    shape: "circle",
    filled: true,
  },
  thinking: {
    colorToken: "var(--app-accent)",
    pulsing: false,
    labelKey: "statusThinking",
    severityRank: 4,
    shape: "circle",
    filled: true,
  },
  initializing: {
    colorToken: DEFAULT_STATUS_COLOR_TOKEN,
    pulsing: true,
    labelKey: "statusInitializing",
    severityRank: 5,
    shape: "circle",
    filled: true,
  },
  active: {
    colorToken: "var(--app-accent)",
    pulsing: false,
    labelKey: "statusActive",
    severityRank: 6,
    shape: "circle",
    filled: true,
  },
  idle: {
    colorToken: DEFAULT_STATUS_COLOR_TOKEN,
    pulsing: false,
    labelKey: "statusIdle",
    severityRank: 7,
    shape: "circle",
    filled: false,
  },
  exited: {
    colorToken: DEFAULT_STATUS_COLOR_TOKEN,
    pulsing: false,
    labelKey: "statusExited",
    severityRank: 8,
    shape: "circle",
    filled: false,
  },
} as const satisfies Record<TerminalStatusType, StatusPresentation>;

export function getStatusPresentation(
  status: TerminalStatusType | null | undefined,
): StatusPresentation | null {
  if (!status) return null;
  return TERMINAL_STATUS_PRESENTATION[status] ?? null;
}

export function statusColorToken(status: TerminalStatusType | null | undefined): string {
  return getStatusPresentation(status)?.colorToken ?? DEFAULT_STATUS_COLOR_TOKEN;
}

export function statusLabelKey(status: TerminalStatusType | null | undefined): StatusLabelKey | null {
  return getStatusPresentation(status)?.labelKey ?? null;
}

export function isStatusPulsing(status: TerminalStatusType | null | undefined): boolean {
  return getStatusPresentation(status)?.pulsing ?? false;
}

export function severityRank(status: TerminalStatusType | null | undefined): number {
  return getStatusPresentation(status)?.severityRank ?? UNKNOWN_STATUS_SEVERITY_RANK;
}
