/** One subscription usage-limit window, exactly as the CLI reported it. */
export interface RateLimitWindow {
  /** Slot the CLI reported it in, e.g. `primary` / `secondary`. */
  slot: string;
  /** 0-100. */
  usedPercent: number;
  windowMinutes: number | null;
  /** Epoch milliseconds; null when the CLI gave no reset time. */
  resetsAt: number | null;
}

/** Subscription usage limits observed in a CLI session log (account-wide, as fresh as the last request). */
export interface RateLimitSnapshot {
  /** e.g. `codex-session-log`. */
  source: string;
  windows: RateLimitWindow[];
  planType: string | null;
  limitReachedType: string | null;
  /** Epoch milliseconds of the log event. */
  observedAt: number | null;
}
