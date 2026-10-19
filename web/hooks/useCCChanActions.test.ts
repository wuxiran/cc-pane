import "@/stores";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { DEFAULT_CCCHAN_SETTINGS, useCCChanStore } from "@/stores/useCCChanStore";
import { useCCChanActions } from "./useCCChanActions";
vi.mock("@/components/notifications/notificationActions", () => ({ focusNotificationSession: vi.fn(async () => true) }));
vi.mock("@/components/settings/settingsNavigation", () => ({ navigateToSettings: vi.fn() }));
vi.mock("@/services/runtime", async (original) => ({ ...await original<object>(), getCurrentWindowIfTauri: () => null }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
beforeEach(() => {
  handlers.clear(); vi.clearAllMocks();
  vi.mocked(getCurrentWebview().listen).mockImplementation(async (name, handler) => {
    handlers.set(name, handler as (event: { payload: unknown }) => void);
    return () => { handlers.delete(name); };
  });
});
it("connects pet settings and session-dot actions to the main window", async () => {
  renderHook(useCCChanActions);
  await act(async () => {
    handlers.get("ccchan:open-settings")!({ payload: null });
    handlers.get("ccchan:focus-session")!({ payload: { sessionId: "session-1" } });
  });
  expect(navigateToSettings).toHaveBeenCalledWith({ paneId: "ccchan" });
  expect(focusNotificationSession).toHaveBeenCalledWith("session-1");
});
it("updates the toolbar when the pet window hides itself", async () => {
  renderHook(useCCChanActions);
  useCCChanStore.setState({ settings: { ...DEFAULT_CCCHAN_SETTINGS, windowVisible: true } });
  await act(async () => handlers.get("ccchan:settings-updated")!({ payload: DEFAULT_CCCHAN_SETTINGS }));
  expect(useCCChanStore.getState().settings.windowVisible).toBe(false);
});
