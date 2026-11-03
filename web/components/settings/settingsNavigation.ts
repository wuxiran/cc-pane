import { openSettingsWindow, usesSettingsWindow, isSettingsWindow } from "@/services/settingsWindowService";
import { useDialogStore } from "@/stores";
import { handleErrorSilent } from "@/utils";
import type { SettingsPaneId } from "./settingsRegistry";

export const SETTINGS_NAVIGATE_EVENT = "cc-panes:settings-navigate";

export interface SettingsNavigationTarget {
  paneId: SettingsPaneId;
  targetSectionId?: string;
}

export function navigateToSettings(target: SettingsNavigationTarget): void {
  if (usesSettingsWindow()) {
    openSettingsWindow(target).catch((error) => handleErrorSilent(error, "open settings window"));
    return;
  }
  if (!isSettingsWindow()) useDialogStore.getState().openSettings();
  window.dispatchEvent(new CustomEvent<SettingsNavigationTarget>(SETTINGS_NAVIGATE_EVENT, {
    detail: target,
  }));
}
