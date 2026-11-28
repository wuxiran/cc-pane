import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { openBotChat, requestBotCreate } from "@/components/bots/openBotChat";
import { botService } from "@/services/botService";
import { invokeIfTauri } from "@/services/runtime";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useActivityBarStore, usePanesStore, useSettingsStore } from "@/stores";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { useTerminalInputActivityStore } from "@/stores/useTerminalInputActivityStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { listenCCChan } from "@/ccchan/listen";
import { REQUEST_DIRECTORY_EVENT, SESSION_DIRECTORY_EVENT } from "@/ccchan/usePetSessions";
import type { CCChanSettings, SessionDirectoryEntry } from "@/ccchan/types";

const DIRECTORY_THROTTLE_MS = 300;

async function showMain() {
  await invokeIfTauri("focus_ccchan_main");
}

/**
 * 会话目录：会话 id → 标签名 + 用户此刻是否在看（主窗口聚焦且标签可见）
 * + 最后一次真实键盘输入（任务球「最近输入优先」）+ 是否主窗口当前激活的会话。
 * 任务球是独立 webview，读不到主窗口 store，输入时间戳只能经这条通道过去。
 */
export function buildSessionDirectory(focused: boolean): SessionDirectoryEntry[] {
  const panes = usePanesStore.getState();
  const views = useTabViewStateStore.getState();
  const inputs = useTerminalInputActivityStore.getState().entries;
  const activePanel = panes.activePane();
  const entries: SessionDirectoryEntry[] = [];
  for (const sessionId of useTerminalStatusStore.getState().statusMap.keys()) {
    const location = panes.findTabBySessionAcrossLayouts(sessionId);
    if (!location) continue;
    const tab = location.tab;
    entries.push({
      sessionId,
      title: tab.title?.trim() || sessionId.slice(0, 8),
      viewed: focused && Boolean(views.getAggregate(tab.id)?.anyVisible),
      lastInputAt: inputs[sessionId]?.lastInputAt ?? null,
      active: activePanel?.id === location.panel.id && activePanel.activeTabId === tab.id,
    });
  }
  return entries;
}

/** 主窗口 → 宠物窗口推会话目录（只在宠物可见时推，节流）。 */
function startDirectoryPublisher(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    timer = null;
    if (!useCCChanStore.getState().settings.windowVisible) return;
    const focused = typeof document === "undefined" || document.hasFocus();
    void emitTo("ccchan", SESSION_DIRECTORY_EVENT, { sessions: buildSessionDirectory(focused) })
      .catch(() => {});
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(publish, DIRECTORY_THROTTLE_MS);
  };
  const unsubscribers = [
    useTerminalStatusStore.subscribe(schedule),
    usePanesStore.subscribe(schedule),
    useTabViewStateStore.subscribe(schedule),
    useCCChanStore.subscribe(schedule),
    useTerminalInputActivityStore.subscribe(schedule),
  ];
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  const stopRequest = listenCCChan(REQUEST_DIRECTORY_EVENT, schedule);
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribers.forEach((fn) => fn());
    window.removeEventListener("focus", schedule);
    window.removeEventListener("blur", schedule);
    stopRequest();
  };
}

function openBotsView(create: boolean) {
  useActivityBarStore.setState({
    appViewMode: "panes",
    activeView: "contacts",
    sidebarVisible: true,
    orchestrationOverlayOpen: false,
  });
  if (create) requestBotCreate();
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
      listenCCChan<{ botId: string }>("ccchan:open-bot-chat", ({ payload }) => {
        void showMain()
          .then(() => botService.list())
          .then((bots) => {
            const bot = bots.find((item) => item.id === payload.botId);
            if (bot) openBotChat(bot);
          })
          .catch((error) => console.warn("[ccchan] open bot chat:", error));
      }),
      listenCCChan<{ create?: boolean }>("ccchan:open-bots", ({ payload }) => {
        void showMain()
          .then(() => openBotsView(Boolean(payload?.create)))
          .catch((error) => console.warn("[ccchan] open bots:", error));
      }),
      listenCCChan<CCChanSettings>("ccchan:settings-updated", ({ payload }) => {
        useCCChanStore.getState().applySettings(payload);
        useSettingsStore.setState((state) => state.settings
          ? { settings: { ...state.settings, ccchan: payload } } : {});
      }),
      startDirectoryPublisher(),
    ];
    return () => dispose.forEach((fn) => fn());
  }, []);
}
