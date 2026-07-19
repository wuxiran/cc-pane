// MainApp 晚段生命周期 effects（从 App.tsx 原样搬出，勿在此做行为改动）。
// effect 顺序与原 App.tsx 一致：初始化 → 主题同步 → 历史 touch → Ctrl+E →
// popup 关闭通知 → popup 销毁兜底。
import { useCallback, useEffect, useState } from "react";
import {
  usePanesStore,
  useThemeStore,
  useTerminalStatusStore,
  useNotificationStore,
  useSettingsStore,
  useLaunchProfilesStore,
  useResourceStatsStore,
  useEnvironmentStore,
} from "@/stores";
import {
  historyService,
  checkUpdateSilent,
  markTabReclaimed as popupMarkReclaimed,
  getPoppedTabs,
} from "@/services";
import { isTauriRuntime, listenIfTauri } from "@/services/runtime";
import { waitForDesktopRuntime } from "@/utils/desktopRuntime";
import { logRestoreReport } from "@/utils/restoreReport";
import i18n from "@/i18n";

export function useAppLifecycleLate(): {
  recentFilesOpen: boolean;
  closeRecentFiles: () => void;
} {
  const themeMode = useSettingsStore((s) => s.settings?.theme.mode);

  // RecentFilesPicker 状态
  const [recentFilesOpen, setRecentFilesOpen] = useState(false);
  const closeRecentFiles = useCallback(() => setRecentFilesOpen(false), []);

  // 初始化设置 + TerminalStatusStore。桌面等待 IPC；Web 直接走 HTTP adapters。
  useEffect(() => {
    let cancelled = false;
    waitForDesktopRuntime().then(async (ready) => {
      if (cancelled || (isTauriRuntime() && !ready)) return;
      await useSettingsStore.getState().loadSettings();
      if (cancelled) return;
      // 从 Settings 同步语言到 i18n
      const lang = useSettingsStore.getState().settings?.general.language;
      if (lang && lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
      useTerminalStatusStore.getState().init();
      useNotificationStore.getState().init().catch(console.error);
      if (isTauriRuntime()) {
        useResourceStatsStore.getState().init();
      }
      useEnvironmentStore.getState().init();
      useLaunchProfilesStore.getState().load().catch(console.error);
      // 重启恢复报告：把各 tab 的 resumeId 绑定状态写入应用日志（[restore-report]）
      logRestoreReport().catch(console.error);
      // 应用启动后静默检查更新（仅写入 store，不弹窗）
      if (isTauriRuntime()) {
        checkUpdateSilent().catch(console.error);
      }
      // [暂时禁用] macOS 下 Dialog 按钮不可点击，暂停 onboarding 引导
      // const loadedSettings = useSettingsStore.getState().settings;
      // if (loadedSettings && !loadedSettings.general.onboardingCompleted) {
      //   localStorage.removeItem("cc-panes-layout");
      //   usePanesStore.persist.rehydrate();
      //   useDialogStore.getState().openOnboarding();
      // }
    });
    return () => {
      cancelled = true;
      useTerminalStatusStore.getState().cleanup();
      useNotificationStore.getState().cleanup();
      useResourceStatsStore.getState().cleanup();
    };
  }, []);

  useEffect(() => {
    if (themeMode === "dark" || themeMode === "light" || themeMode === "system") {
      useThemeStore.getState().setThemeMode(themeMode);
    }
  }, [themeMode]);

  // 重启时为 rehydrated Claude tabs touch 历史记录时间戳
  useEffect(() => {
    waitForDesktopRuntime().then((ready) => {
      if (isTauriRuntime() && !ready) return;
      const allPanels = usePanesStore.getState().allPanelsAcrossLayouts();
      for (const panel of allPanels) {
        for (const tab of panel.tabs) {
          if (tab.resumeId && tab.resumeId !== "new" && tab.launchClaude) {
            historyService.touchBySessionId(tab.resumeId).then((id) => {
              if (id !== null) {
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              }
            }).catch(console.error);
          }
        }
      }
    });
  }, []);

  // Ctrl+E 全局快捷键（最近文件）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "e") {
        e.preventDefault();
        setRecentFilesOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 监听 Rust 侧 popup 窗口关闭通知（on_window_event 发射）
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri<string>("popup-window-closing", (e) => {
      if (cancelled) return;
      const label = e.payload;
      const poppedTabs = getPoppedTabs();
      for (const [tabId, windowLabel] of poppedTabs) {
        if (windowLabel === label) {
          usePanesStore.getState().markTabReclaimed(tabId);
          popupMarkReclaimed(tabId);
          break;
        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Fallback: 监听 popup 窗口销毁事件，防止 reclaim 事件丢失
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri<{ label: string }>("tauri://window-destroyed", (e) => {
      if (cancelled) return;
      const label = (e.payload as { label?: string })?.label ?? "";
      if (!label.startsWith("popup-")) return;
      // 从 popupWindowService 的映射中查找对应的 tabId
      const poppedTabs = getPoppedTabs();
      for (const [tabId, windowLabel] of poppedTabs) {
        if (windowLabel === label) {
          console.info(`[popup-fallback] Window ${label} destroyed, reclaiming tab ${tabId}`);
          usePanesStore.getState().markTabReclaimed(tabId);
          popupMarkReclaimed(tabId);
          break;
        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { recentFilesOpen, closeRecentFiles };
}
