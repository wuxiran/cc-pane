import { useEffect } from "react";
import i18n from "@/i18n";
import { getCurrentWindowIfTauri, listenIfTauri } from "@/services/runtime";
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_WINDOW_ACTION_EVENT,
  type SettingsWindowAction,
} from "@/services/settingsWindowService";
import { useDialogStore, usePanesStore, useSettingsStore, useThemeStore } from "@/stores";
import { useDescriptionLangStore } from "@/stores/useDescriptionLangStore";
import { UI_DENSITY_STORAGE_KEY, useDensityStore } from "@/stores/useDensityStore";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { restoreThemeOverridesFromStorage } from "@/stores/useThemeStore";
import { THEME_OVERRIDES_STORAGE_KEY } from "@/theme/themeOverrides";

type OpenSkillManager = (...args: unknown[]) => void;

/** 主窗口一侧：接收设置窗口转发的操作，并同步它改动的本地偏好。 */
export function useSettingsWindowBridge(): void {
  useEffect(() => {
    const actions = listenIfTauri<SettingsWindowAction>(SETTINGS_WINDOW_ACTION_EVENT, (event) => {
      const action = event.payload;
      if (action.type === "openOnboarding") useDialogStore.getState().openOnboarding();
      else if (action.type === "openSkillManager") {
        (usePanesStore.getState().openSkillManager as unknown as OpenSkillManager)(...action.args);
      }
      void getCurrentWindowIfTauri()?.setFocus();
    });
    // 语言不在 store 订阅链上；主题和其余设置由 settings 变化驱动。
    const language = listenIfTauri(SETTINGS_CHANGED_EVENT, () => {
      window.setTimeout(() => {
        const next = useSettingsStore.getState().settings?.general.language;
        if (next && next !== i18n.language) void i18n.changeLanguage(next);
      }, 200);
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === UI_DENSITY_STORAGE_KEY) useDensityStore.getState().setDensity(event.newValue);
      else if (event.key === THEME_OVERRIDES_STORAGE_KEY) {
        const overrides = restoreThemeOverridesFromStorage();
        useThemeStore.setState({ customOverrides: overrides });
        useThemeStore.getState().setThemeMode(useThemeStore.getState().preference);
      } else if (event.key === useModulePrefsStore.persist.getOptions().name) {
        void useModulePrefsStore.persist.rehydrate();
      } else if (event.key === useDescriptionLangStore.persist.getOptions().name) {
        void useDescriptionLangStore.persist.rehydrate();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      for (const off of [actions, language]) void off.then((fn) => fn()).catch(() => undefined);
    };
  }, []);
}
