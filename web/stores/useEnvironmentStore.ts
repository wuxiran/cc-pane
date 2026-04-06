import { create } from "zustand";
import { discoverWslDistros } from "@/services/sshMachineService";
import type { WslDetectionResult } from "@/types";
import { detectAppPlatform, getErrorMessage } from "@/utils";
import type { AppPlatform } from "@/utils/workspaceLaunch";

interface EnvironmentState {
  platform: AppPlatform;
  wsl: WslDetectionResult;
  _initialized: boolean;
  init: () => Promise<void>;
  refreshWsl: () => Promise<void>;
}

function createIdleWslResult(): WslDetectionResult {
  return {
    status: "idle",
    available: false,
    distros: [],
    error: null,
    detectedAt: null,
  };
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => {
  const runWslDetection = async (platform: AppPlatform) => {
    if (platform !== "windows") {
      set({
        platform,
        wsl: {
          status: "done",
          available: false,
          distros: [],
          error: null,
          detectedAt: null,
        },
      });
      return;
    }

    if (get().wsl.status === "detecting") return;

    set((state) => ({
      ...state,
      platform,
      wsl: {
        ...state.wsl,
        status: "detecting",
        error: null,
      },
    }));

    try {
      const distros = await discoverWslDistros();
      set({
        platform,
        wsl: {
          status: "done",
          available: distros.length > 0,
          distros,
          error: null,
          detectedAt: Date.now(),
        },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      console.warn("[EnvironmentStore] Failed to detect WSL distros:", error);
      set({
        platform,
        wsl: {
          status: "error",
          available: false,
          distros: [],
          error: message,
          detectedAt: null,
        },
      });
    }
  };

  return {
    platform: detectAppPlatform(),
    wsl: createIdleWslResult(),
    _initialized: false,

    init: async () => {
      if (get()._initialized) return;
      const platform = detectAppPlatform();
      set({ _initialized: true, platform });
      await runWslDetection(platform);
    },

    refreshWsl: async () => {
      const platform = detectAppPlatform();
      await runWslDetection(platform);
    },
  };
});
