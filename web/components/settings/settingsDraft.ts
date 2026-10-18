import type { CCChanSettings } from "@/ccchan/types";
import { DEFAULT_CCCHAN_SETTINGS } from "@/stores/useCCChanStore";
import {
  DEFAULT_EXPERIMENTAL_SETTINGS,
  DEFAULT_PERFORMANCE_SETTINGS,
} from "@/stores/useSettingsStore";
import type { AppSettings } from "@/types";
import type { SettingsPaneId } from "./settingsRegistry";

export type SettingsDraft = AppSettings & { ccchan: CCChanSettings };

export const SECTION_DRAFT_KEYS: Partial<
  Record<SettingsPaneId, (keyof SettingsDraft)[]>
> = {
  theme: ["theme"],
  general: ["general", "localHistory", "update", "tips"],
  notification: ["notification"],
  "im-bridge": ["im"],
  "web-access": ["webAccess", "orchestrator"],
  "cli-launchers": ["cliLaunchers"],
  proxy: ["proxy"],
  terminal: ["terminal"],
  performance: ["performance"],
  "quick-terminal": ["quickTerminal"],
  voice: ["voice"],
  ccchan: ["ccchan"],
  shortcuts: ["shortcuts"],
  screenshot: ["screenshot"],
  wallpaper: ["wallpaper"],
  experimental: ["experimental"],
};

export function createSettingsDraft(value: AppSettings): SettingsDraft {
  const maybeWithCCChan = value as Partial<SettingsDraft>;
  return {
    ...value,
    localHistory: {
      enabled: true,
      ...maybeWithCCChan.localHistory,
    },
    update: {
      notifyEnabled: true,
      skippedVersion: null,
      lastNotifiedAt: null,
      ...maybeWithCCChan.update,
    },
    tips: {
      enabled: true,
      lastShownAt: null,
      dismissRun: 0,
      sessionCount: 0,
      ...maybeWithCCChan.tips,
      seen: maybeWithCCChan.tips?.seen ?? [],
      tried: maybeWithCCChan.tips?.tried ?? [],
    },
    experimental: {
      ...DEFAULT_EXPERIMENTAL_SETTINGS,
      ...maybeWithCCChan.experimental,
    },
    performance: {
      ...DEFAULT_PERFORMANCE_SETTINGS,
      ...maybeWithCCChan.performance,
    },
    ccchan: {
      ...DEFAULT_CCCHAN_SETTINGS,
      ...maybeWithCCChan.ccchan,
    },
  };
}

// These controls live on Performance while their persisted keys remain under
// terminal for compatibility. Reset by UI ownership, not storage object alone.
const PERFORMANCE_TERMINAL_KEYS = ["lowerSessionPriority", "sessionCpuWeight"] as const;

export function resetSettingsSection(
  draft: SettingsDraft,
  defaults: SettingsDraft,
  paneId: SettingsPaneId,
): SettingsDraft {
  const next = { ...draft };
  for (const key of SECTION_DRAFT_KEYS[paneId] ?? []) {
    (next as Record<string, unknown>)[key] = defaults[key];
  }
  if (paneId === "terminal" || paneId === "performance") {
    next.terminal = { ...next.terminal };
    const policy = paneId === "performance" ? defaults.terminal : draft.terminal;
    for (const key of PERFORMANCE_TERMINAL_KEYS) {
      Object.assign(next.terminal, { [key]: policy[key] });
    }
  }
  return next;
}
