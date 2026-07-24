import { useDialogStore } from "@/stores";
import type { SettingsPaneId } from "./settingsRegistry";

export const SETTINGS_NAVIGATE_EVENT = "cc-panes:settings-navigate";

export interface SettingsNavigationTarget {
  paneId: SettingsPaneId;
  targetSectionId?: string;
}

export function navigateToSettings(target: SettingsNavigationTarget): void {
  useDialogStore.getState().openSettings();
  window.dispatchEvent(new CustomEvent<SettingsNavigationTarget>(SETTINGS_NAVIGATE_EVENT, {
    detail: target,
  }));
}
