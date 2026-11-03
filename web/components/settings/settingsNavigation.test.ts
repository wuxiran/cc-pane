import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "@/services/runtime";
import { useDialogStore } from "@/stores";
import { navigateToSettings, SETTINGS_NAVIGATE_EVENT } from "./settingsNavigation";

describe("navigateToSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useDialogStore.setState({ settingsOpen: false });
  });

  it("桌面主窗口打开独立设置窗口，不再开弹窗", () => {
    navigateToSettings({ paneId: "theme" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("open_settings_window", { paneId: "theme", sectionId: null });
    expect(useDialogStore.getState().settingsOpen).toBe(false);
  });

  it("Web 壳继续用弹窗", () => {
    vi.spyOn(runtime, "isTauriRuntime").mockReturnValue(false);
    const seen = vi.fn();
    window.addEventListener(SETTINGS_NAVIGATE_EVENT, seen);
    navigateToSettings({ paneId: "theme" });
    window.removeEventListener(SETTINGS_NAVIGATE_EVENT, seen);
    expect(useDialogStore.getState().settingsOpen).toBe(true);
    expect(seen).toHaveBeenCalledOnce();
  });
});
