import { create } from "zustand";
import { settingsService } from "@/services";
import type { AppSettings } from "@/types";

interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (newSettings: AppSettings) => Promise<void>;
  getDefaults: () => AppSettings;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,

  loadSettings: async () => {
    set({ loading: true });
    try {
      const settings = await settingsService.getSettings();
      set({ settings });
    } catch (e) {
      console.error("Failed to load settings:", e);
    } finally {
      set({ loading: false });
    }
  },

  saveSettings: async (newSettings) => {
    try {
      await settingsService.updateSettings(newSettings);
      set({ settings: newSettings });
    } catch (e) {
      console.error("Failed to save settings:", e);
      throw e;
    }
  },

  getDefaults: () => ({
    proxy: {
      enabled: false,
      proxyType: "http",
      host: "",
      port: 7890,
      username: null,
      password: null,
      noProxy: "localhost,127.0.0.1",
    },
    theme: {
      mode: "dark",
    },
    terminal: {
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 1000,
    },
    shortcuts: {
      bindings: {
        "toggle-sidebar": "Ctrl+B",
        "toggle-fullscreen": "F11",
        "new-tab": "Ctrl+T",
        "close-tab": "Ctrl+W",
        settings: "Ctrl+,",
        "split-right": "Ctrl+\\",
        "split-down": "Ctrl+-",
        "next-tab": "Ctrl+Tab",
        "prev-tab": "Ctrl+Shift+Tab",
        "toggle-mini-mode": "Ctrl+M",
        "switch-tab-1": "Ctrl+1",
        "switch-tab-2": "Ctrl+2",
        "switch-tab-3": "Ctrl+3",
        "switch-tab-4": "Ctrl+4",
        "switch-tab-5": "Ctrl+5",
        "switch-tab-6": "Ctrl+6",
        "switch-tab-7": "Ctrl+7",
        "switch-tab-8": "Ctrl+8",
        "switch-tab-9": "Ctrl+9",
      },
    },
    general: {
      closeToTray: true,
      autoStart: false,
      language: "zh-CN",
      dataDir: null,
    },
    notification: {
      enabled: true,
      onExit: true,
      onWaitingInput: true,
      onlyWhenUnfocused: true,
    },
  }),
}));
