import { useEffect } from "react";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { invokeIfTauri } from "@/services/runtime";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useSettingsStore } from "@/stores";
import { listenCCChan } from "@/ccchan/listen";
import type { CCChanSettings } from "@/ccchan/types";

async function showMain() {
  await invokeIfTauri("focus_ccchan_main");
}

export function useCCChanActions() {
  useEffect(() => {
    const dispose = [
      listenCCChan("ccchan:open-settings", () => {
        navigateToSettings({ paneId: "ccchan" });
        void showMain().catch((error) => console.warn("[ccchan] show settings:", error));
      }),
      listenCCChan<{ sessionId: string }>("ccchan:focus-session", ({ payload }) => {
        void showMain().then(() => focusNotificationSession(payload.sessionId))
          .catch((error) => console.warn("[ccchan] focus session:", error));
      }),
      listenCCChan<CCChanSettings>("ccchan:settings-updated", ({ payload }) => {
        useCCChanStore.getState().applySettings(payload);
        useSettingsStore.setState((state) => state.settings
          ? { settings: { ...state.settings, ccchan: payload } } : {});
      }),
    ];
    return () => dispose.forEach((fn) => fn());
  }, []);
}
