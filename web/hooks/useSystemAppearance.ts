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

  // 窗口外观跟随应用主题：系统材质和原生标题栏按窗口外观绘制，不同步的话
  // 系统浅色 + 应用暗色时外壳会是亮底配亮字。跟随系统时交还给系统，并响应系统切换。
  const preference = useThemeStore((state) => state.preference);
  const isDark = useThemeStore((state) => state.isDark);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const followSystem = preference === "system";
    Promise.resolve(
      getCurrentWindowIfTauri()?.setTheme(followSystem ? null : isDark ? "dark" : "light"),
    ).catch((error) => handleErrorSilent(error, "sync window theme"));
  }, [preference, isDark]);
  useEffect(() => {
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => useThemeStore.getState().setThemeMode("system");
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [preference]);

  useEffect(() => {
    if (!isTauriRuntime() || isSettingsWindow()) return;
    let disposed = false;
    systemAppearanceService.isMaterialActive().then((active) => {
      if (!disposed && active) document.documentElement.dataset.material = "on";
    }).catch((error) => handleErrorSilent(error, "window material"));
    return () => { disposed = true; };
  }, []);
}
