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
it("builds the pet session directory from tab titles and view state", async () => {
  const { buildSessionDirectory } = await import("./useCCChanActions");
  const { usePanesStore } = await import("@/stores");
  const { useTabViewStateStore } = await import("@/stores/useTabViewStateStore");
  const { useTerminalStatusStore } = await import("@/stores/useTerminalStatusStore");
  useTerminalStatusStore.setState({
    statusMap: new Map([
      ["s1", { sessionId: "s1", status: "idle", lastOutputAt: 0, updatedAt: 0 }],
      ["orphan", { sessionId: "orphan", status: "idle", lastOutputAt: 0, updatedAt: 0 }],
    ]),
  });
  const find = vi.spyOn(usePanesStore.getState(), "findTabBySessionAcrossLayouts");
  find.mockImplementation((sessionId: string) => (sessionId === "s1"
    ? { tab: { id: "tab-1", title: "修复登录" } } as never
    : null));
  useTabViewStateStore.getState().reportView("tab-1", "primary", "active");
  expect(buildSessionDirectory(true)).toEqual([{ sessionId: "s1", title: "修复登录", viewed: true }]);
  expect(buildSessionDirectory(false)[0].viewed).toBe(false);
  find.mockRestore();
});
it("opens the bot conversation in the main window", async () => {
  const { botService } = await import("@/services/botService");
  const openBot = await import("@/components/bots/openBotChat");
  const list = vi.spyOn(botService, "list").mockResolvedValue([
    { id: "b1", name: "B", chatId: "bot-b1", effectiveCwd: "/tmp" } as never,
  ]);
  const open = vi.spyOn(openBot, "openBotChat").mockImplementation(() => {});
  renderHook(useCCChanActions);
  await act(async () => handlers.get("ccchan:open-bot-chat")!({ payload: { botId: "b1" } }));
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" })));
  list.mockRestore();
  open.mockRestore();
});
