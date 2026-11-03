import { useEffect } from "react";
import { getCurrentWindowIfTauri, isTauriRuntime } from "@/services/runtime";
import { isSettingsWindow } from "@/services/settingsWindowService";
import { systemAppearanceService } from "@/services/systemAppearanceService";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { applyThemeOverrides, useThemeStore } from "@/stores/useThemeStore";
import { applySystemAccent, clearSystemAccent, isHexColor } from "@/theme/systemAccent";
import { handleErrorSilent } from "@/utils";

/** 跟随系统强调色（回到窗口时刷新），并标记主窗口的系统材质是否生效。 */
export function useSystemAppearance(): void {
  const enabled = useSettingsStore((state) => state.settings?.theme.systemAccent === true);
  const themeId = useThemeStore((state) => state.themeId);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (!enabled) {
      clearSystemAccent();
      const { customOverrides, themeId: current } = useThemeStore.getState();
      applyThemeOverrides(customOverrides, current);
      return;
    }
    let disposed = false;
    const refresh = () => {
      systemAppearanceService.getAccentColor().then((color) => {
        if (!disposed && isHexColor(color)) applySystemAccent(color);
      }).catch((error) => handleErrorSilent(error, "system accent"));
    };
    refresh();
    const unlisten = getCurrentWindowIfTauri()?.onFocusChanged(({ payload }) => {
      if (payload) refresh();
    });
    return () => {
      disposed = true;
      void unlisten?.then((fn) => fn()).catch(() => undefined);
    };
  }, [enabled, themeId]);

  useEffect(() => {
    if (!isTauriRuntime() || isSettingsWindow()) return;
    let disposed = false;
    systemAppearanceService.isMaterialActive().then((active) => {
      if (!disposed && active) document.documentElement.dataset.material = "on";
    }).catch((error) => handleErrorSilent(error, "window material"));
    return () => { disposed = true; };
  }, []);
}
