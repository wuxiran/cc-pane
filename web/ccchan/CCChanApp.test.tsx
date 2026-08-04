import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import i18n from "@/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CCCHAN_SETTINGS, FALLBACK_PET, useCCChanStore } from "@/stores/useCCChanStore";
import { useTerminalStatusStore } from "@/stores";
import { CCChanApp } from "./CCChanApp";

type WebviewListener = (event: { payload: unknown }) => void;

const mockOuterPosition = vi.fn(() => Promise.resolve({ x: 200, y: 120 }));
const mockScaleFactor = vi.fn(() => Promise.resolve(1));
const mockClose = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  currentMonitor: vi.fn(() => Promise.resolve(null)),
  getCurrentWindow: vi.fn(() => ({
    outerPosition: mockOuterPosition,
    scaleFactor: mockScaleFactor,
    close: mockClose,
  })),
}));

function createWebviewListenerRegistry() {
  const listeners = new Map<string, Set<WebviewListener>>();
  vi.mocked(getCurrentWebview().listen).mockImplementation(async (eventName, handler) => {
    const eventListeners = listeners.get(eventName) ?? new Set<WebviewListener>();
    const listener = handler as WebviewListener;
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
    return () => {
      eventListeners.delete(listener);
    };
  });

  return {
    emit(eventName: string, payload: unknown) {
      for (const listener of listeners.get(eventName) ?? []) {
        listener({ payload });
      }
    },
    listenerCount(eventName: string) {
      return listeners.get(eventName)?.size ?? 0;
    },
  };
}

function mockCcChanInvoke(settings = DEFAULT_CCCHAN_SETTINGS) {
  const mockInvoke = invoke as ReturnType<typeof vi.fn>;
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_ccchan_settings") return Promise.resolve(settings);
    if (cmd === "get_ccchan_pets") return Promise.resolve([FALLBACK_PET]);
    if (cmd === "get_all_terminal_status") return Promise.resolve([]);
    if (cmd === "resize_ccchan_for_chat") return Promise.resolve(undefined);
    if (cmd === "resize_ccchan_for_menu") return Promise.resolve(undefined);
    if (cmd === "resize_ccchan_for_bubble") return Promise.resolve(undefined);
    if (cmd === "start_ccchan_chat") return Promise.resolve("chat-session");
    if (cmd === "is_ccchan_chat_session_alive") return Promise.resolve(args?.sessionId !== "dead-chat");
    return Promise.resolve(undefined);
  });
  return mockInvoke;
}

describe("CCChanApp pet interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWebviewListenerRegistry();
    useCCChanStore.setState({
      settings: DEFAULT_CCCHAN_SETTINGS,
      pets: [FALLBACK_PET],
      expanded: false,
      chatSessionId: null,
      loading: false,
      loaded: false,
    });
    useTerminalStatusStore.setState({
      statusMap: new Map(),
      _unlisten: null,
      _idleCheckInterval: null,
      _initialized: false,
    });
  });

  it("opens chat on a fast left pointer click before window position resolves", async () => {
    const mockInvoke = mockCcChanInvoke();
    let resolvePosition: (position: { x: number; y: number }) => void = () => {};
    mockOuterPosition.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePosition = resolve;
      }),
    );

    render(<CCChanApp />);

    const pet = screen.getByTitle("打开 cc酱 chat");
    fireEvent.pointerDown(pet, {
      button: 0,
      pointerId: 7,
      screenX: 24,
      screenY: 24,
    });
    fireEvent.pointerUp(pet, {
      button: 0,
      pointerId: 7,
      screenX: 24,
      screenY: 24,
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("resize_ccchan_for_chat", { expanded: true });
    });
    resolvePosition({ x: 200, y: 120 });
  });

  it("switches cc-chan labels when the app language changes", async () => {
    mockCcChanInvoke();
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    render(<CCChanApp />);

    expect(screen.getByTitle("打开 cc酱 chat")).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("en");
    });

    expect(screen.getByTitle("Open cc-chan chat")).toBeInTheDocument();
    expect(screen.queryByTitle("打开 cc酱 chat")).not.toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
  });

  it("opens the menu from right pointer down and can open chat from the menu", async () => {
    const mockInvoke = mockCcChanInvoke();

    render(<CCChanApp />);

    const pet = screen.getByTitle("打开 cc酱 chat");
    fireEvent.pointerDown(pet, {
      button: 2,
      pointerId: 8,
      screenX: 24,
      screenY: 24,
    });

    const openChatItem = await screen.findByRole("button", { name: "打开对话" });
    fireEvent.click(openChatItem);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("resize_ccchan_for_chat", { expanded: true });
    });
  });

  it("keeps the active chat transcript when the panel is closed and opened again", async () => {
    const listeners = createWebviewListenerRegistry();
    const mockInvoke = mockCcChanInvoke();

    render(<CCChanApp />);

    fireEvent.click(screen.getByTitle("打开 cc酱对话"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("start_ccchan_chat", {
        aiEngine: DEFAULT_CCCHAN_SETTINGS.aiEngine,
      });
    });
    await waitFor(() => {
      expect(listeners.listenerCount("ccchan-chat-output")).toBeGreaterThan(0);
    });

    act(() => {
      listeners.emit("ccchan-chat-output", {
        sessionId: "chat-session",
        role: "assistant",
        text: "这条回复关闭后还应该在。",
      });
    });

    expect(await screen.findByText("这条回复关闭后还应该在。")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("关闭 chat"));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("resize_ccchan_for_chat", { expanded: false });
    });

    fireEvent.click(screen.getByTitle("打开 cc酱对话"));

    expect(await screen.findByText("这条回复关闭后还应该在。")).toBeInTheDocument();
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "start_ccchan_chat")).toHaveLength(1);
  });

  it("applies settings pushed via ccchan:settings-updated without reloading", async () => {
    const listeners = createWebviewListenerRegistry();
    mockCcChanInvoke();

    render(<CCChanApp />);

    await waitFor(() => {
      expect(listeners.listenerCount("ccchan:settings-updated")).toBeGreaterThan(0);
    });

    act(() => {
      listeners.emit("ccchan:settings-updated", {
        ...DEFAULT_CCCHAN_SETTINGS,
        wanderEnabled: true,
        petSize: 200,
      });
    });

    const settings = useCCChanStore.getState().settings;
    expect(settings.wanderEnabled).toBe(true);
    expect(settings.petSize).toBe(200);
  });
});

describe("CCChanApp wandering", () => {
  const wanderMonitor = {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createWebviewListenerRegistry();
    useCCChanStore.setState({
      settings: DEFAULT_CCCHAN_SETTINGS,
      pets: [FALLBACK_PET],
      expanded: false,
      chatSessionId: null,
      loading: false,
      loaded: false,
    });
    useTerminalStatusStore.setState({
      statusMap: new Map(),
      _unlisten: null,
      _idleCheckInterval: null,
      _initialized: false,
    });
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.9);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function moveCalls(mockInvoke: ReturnType<typeof vi.fn>) {
    return mockInvoke.mock.calls.filter(([cmd]) => cmd === "move_ccchan_window");
  }

  it("does not wander when wanderEnabled is off (default)", async () => {
    const mockInvoke = mockCcChanInvoke();
    const { currentMonitor } = await import("@tauri-apps/api/window");
    vi.mocked(currentMonitor).mockResolvedValue(wanderMonitor as never);

    render(<CCChanApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(moveCalls(mockInvoke)).toHaveLength(0);
  });

  it("wanders when wanderEnabled is on and stops after toggling off", async () => {
    const mockInvoke = mockCcChanInvoke({ ...DEFAULT_CCCHAN_SETTINGS, wanderEnabled: true });
    const { currentMonitor } = await import("@tauri-apps/api/window");
    vi.mocked(currentMonitor).mockResolvedValue(wanderMonitor as never);
    useCCChanStore.setState({
      settings: { ...DEFAULT_CCCHAN_SETTINGS, wanderEnabled: true },
    });

    render(<CCChanApp />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(moveCalls(mockInvoke).length).toBeGreaterThan(0);

    // 走动途中关闭开关：在途 step 应立即停止，不再发移动
    act(() => {
      useCCChanStore.getState().applySettings({
        ...DEFAULT_CCCHAN_SETTINGS,
        wanderEnabled: false,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const countAfterDisable = moveCalls(mockInvoke).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(moveCalls(mockInvoke)).toHaveLength(countAfterDisable);
  });
});
