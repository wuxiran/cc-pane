import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DEFAULT_CCCHAN_SETTINGS, FALLBACK_PET, useCCChanStore } from "@/stores/useCCChanStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { TerminalStatusInfo } from "@/types";
import { CCChanApp } from "./CCChanApp";
import { ORB_TIMINGS } from "./orbModel";
import { ORB_PINNED_STORAGE_KEY, togglePinned } from "./useOrbPinned";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: vi.fn(), startDragging: vi.fn(() => Promise.resolve()) }),
}));

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
const emitWebview = (name: string, payload: unknown) => {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
};

const ORB_SETTINGS = { ...DEFAULT_CCCHAN_SETTINGS, appearance: "orb" as const };
const status = (sessionId: string, value: TerminalStatusInfo["status"]): TerminalStatusInfo =>
  ({ sessionId, status: value, lastOutputAt: 0, updatedAt: 1 });

function mockInvoke(statuses: TerminalStatusInfo[]) {
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: { expanded?: boolean; panelHeight?: number }) => {
    if (cmd === "get_ccchan_settings") return Promise.resolve(ORB_SETTINGS);
    if (cmd === "get_ccchan_pets") return Promise.resolve([FALLBACK_PET]);
    if (cmd === "get_all_terminal_status") return Promise.resolve(statuses);
    if (cmd === "set_ccchan_orb_expanded") {
      return Promise.resolve(args?.expanded
        ? { expanded: true, width: 320, height: 88 + (args.panelHeight ?? 0), orbX: 0, orbY: 0, alignRight: false, openUp: false }
        : { expanded: false, width: 84, height: 84, orbX: 0, orbY: 0, alignRight: false, openUp: false });
    }
    return Promise.resolve(undefined);
  }) as never);
}

const directory = (sessions: Array<{ sessionId: string; lastInputAt?: number | null; active?: boolean }>) =>
  emitWebview("ccchan:session-directory", {
    sessions: sessions.map((item) => ({ title: `tab-${item.sessionId}`, viewed: false, ...item })),
  });

async function renderOrb(statuses: TerminalStatusInfo[]) {
  mockInvoke(statuses);
  render(<CCChanApp />);
  await waitFor(() => expect(useTerminalStatusStore.getState().statusMap.size).toBe(statuses.length));
  await waitFor(() => expect(listeners.get("ccchan:session-directory")?.size).toBeGreaterThan(0));
  return screen.findByTestId("task-orb");
}

function click(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });
  fireEvent.pointerUp(target, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });
}

describe("TaskOrbApp", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    localStorage.removeItem(ORB_PINNED_STORAGE_KEY);
    await i18n.changeLanguage("zh-CN");
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.mocked(getCurrentWebview().listen).mockImplementation(async (name, handler) => {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(handler as Listener);
      listeners.set(name, set);
      return () => set.delete(handler as Listener);
    });
    useCCChanStore.setState({ settings: ORB_SETTINGS, pets: [FALLBACK_PET], loading: false, loaded: false });
    useTerminalStatusStore.setState({ statusMap: new Map(), _unlisten: null, _idleCheckInterval: null, _initialized: false });
  });

  afterEach(() => vi.useRealTimers());

  it("renders the orb instead of the pet and shows waiting + error count", async () => {
    await renderOrb([status("w", "waitingInput"), status("e", "error"), status("r", "thinking")]);
    expect(screen.getByTestId("task-orb-count")).toHaveTextContent("2");
    expect(screen.getByTestId("task-orb-pulse")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_ccchan_hit_regions", {
      regions: [{ x: 14, y: 14, width: 56, height: 56 }],
      trackCursor: false,
    }));
  });

  it("clicking the orb jumps to the most recently typed session, not the current one", async () => {
    const orb = await renderOrb([status("a", "idle"), status("b", "waitingInput"), status("c", "idle")]);
    act(() => directory([
      { sessionId: "a", lastInputAt: 100 },
      { sessionId: "b", lastInputAt: 50 },
      { sessionId: "c", lastInputAt: 999, active: true },
    ]));
    click(orb);
    expect(emitTo).toHaveBeenCalledWith("main", "ccchan:focus-session", { sessionId: "a" });
  });

  it("expands on hover, lists sessions, and dwell-switches to a row", async () => {
    const orb = await renderOrb([status("a", "idle"), status("b", "idle")]);
    act(() => directory([{ sessionId: "a", lastInputAt: 10 }, { sessionId: "b", lastInputAt: 20 }]));
    vi.useFakeTimers();
    act(() => emitWebview("ccchan:hover", true));
    await act(async () => { vi.advanceTimersByTime(ORB_TIMINGS.openDelayMs); });
    vi.useRealTimers();
    expect(invoke).toHaveBeenCalledWith("set_ccchan_orb_expanded", expect.objectContaining({ expanded: true }));
    const panel = await screen.findByTestId("orb-panel");
    expect(panel).toHaveTextContent("tab-b");
    expect(orb).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_ccchan_hit_regions", expect.objectContaining({ trackCursor: true })));

    vi.useFakeTimers();
    const row = panel.querySelector<HTMLElement>("[data-orb-row='a']")!;
    fireEvent.pointerEnter(row);
    expect(screen.getByTestId("orb-dwell-bar")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(ORB_TIMINGS.dwellSwitchMs); });
    expect(emitTo).toHaveBeenCalledWith("main", "ccchan:focus-session", { sessionId: "a" });
  });

  it("persists pin toggles", () => {
    expect(togglePinned(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePinned(["a", "b"], "a")).toEqual(["b"]);
  });
});
