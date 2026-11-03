// 独立设置窗口：两个窗口的 store 互不相通，靠 settings-changed 事件和 localStorage 同步。
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import SettingsPanel from "@/components/SettingsPanel";
import { SETTINGS_NAVIGATE_EVENT } from "@/components/settings/settingsNavigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSystemAppearance } from "@/hooks/useSystemAppearance";
import i18n from "@/i18n";
import { getCurrentWindowIfTauri, listenIfTauri } from "@/services/runtime";
import {
  currentWindowLabel,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_WINDOW_NAVIGATE_EVENT,
  type SettingsChangedPayload,
  type SettingsWindowTarget,
} from "@/services/settingsWindowService";
import { useSettingsStore, useThemeStore, useWorkspacesStore } from "@/stores";
import { handleErrorSilent } from "@/utils";

function dispatchNavigate(target: SettingsWindowTarget) {
  window.dispatchEvent(new CustomEvent(SETTINGS_NAVIGATE_EVENT, { detail: target }));
}

export default function SettingsWindowRoute() {
  const [ready, setReady] = useState(false);
  const isDark = useThemeStore((state) => state.isDark);
  const themeMode = useSettingsStore((state) => state.settings?.theme.mode);
  const themeShape = useSettingsStore((state) => state.settings?.theme.shape);
  useSystemAppearance();

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      useSettingsStore.getState().loadSettings(),
      useWorkspacesStore.getState().load().catch((error) => handleErrorSilent(error, "load workspaces")),
    ]).then(() => {
      if (disposed) return;
      const language = useSettingsStore.getState().settings?.general.language;
      if (language && language !== i18n.language) void i18n.changeLanguage(language);
      setReady(true);
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (themeMode) useThemeStore.getState().setThemeMode(themeMode);
  }, [themeMode]);
  useEffect(() => {
    if (themeShape) useThemeStore.getState().setThemeShape(themeShape);
  }, [themeShape]);

  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    const paneId = params.get("pane");
    if (paneId) dispatchNavigate({ paneId, targetSectionId: params.get("section") ?? undefined });
  }, [ready]);

  useEffect(() => {
    const offs = [
      listenIfTauri<SettingsWindowTarget>(SETTINGS_WINDOW_NAVIGATE_EVENT, (event) => dispatchNavigate(event.payload)),
      listenIfTauri<SettingsChangedPayload | null>(SETTINGS_CHANGED_EVENT, (event) => {
        if (event.payload?.source && event.payload.source === currentWindowLabel()) return;
        void useSettingsStore.getState().loadSettings();
      }),
    ];
    return () => {
      for (const off of offs) void off.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  if (!ready) return null;
  return (
    <TooltipProvider delayDuration={300}>
      <Toaster position="bottom-center" theme={isDark ? "dark" : "light"} richColors />
      <SettingsPanel
        open
        presentation="window"
        onOpenChange={(open) => {
          if (!open) void getCurrentWindowIfTauri()?.destroy();
        }}
      />
    </TooltipProvider>
  );
}
