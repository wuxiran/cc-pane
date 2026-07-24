import type { CCChanSettings } from "@/ccchan/types";
import { DEFAULT_CCCHAN_SETTINGS } from "@/stores/useCCChanStore";
import type { AppSettings } from "@/types";
import type { SettingsPaneId } from "./settingsRegistry";

export type SettingsDraft = AppSettings & { ccchan: CCChanSettings };

export const SECTION_DRAFT_KEYS: Partial<
  Record<SettingsPaneId, (keyof SettingsDraft)[]>
> = {
  general: ["general", "localHistory"],
  notification: ["notification"],
  "web-access": ["webAccess", "orchestrator"],
  "cli-launchers": ["cliLaunchers"],
  proxy: ["proxy"],
  terminal: ["terminal"],
  voice: ["voice"],
  ccchan: ["ccchan"],
  shortcuts: ["shortcuts"],
  screenshot: ["screenshot"],
  wallpaper: ["wallpaper"],
};

export function createSettingsDraft(value: AppSettings): SettingsDraft {
  const maybeWithCCChan = value as Partial<SettingsDraft>;
  return {
    ...value,
    localHistory: {
      enabled: true,
      ...maybeWithCCChan.localHistory,
    },
    ccchan: {
      ...DEFAULT_CCCHAN_SETTINGS,
      ...maybeWithCCChan.ccchan,
    },
  };
}
