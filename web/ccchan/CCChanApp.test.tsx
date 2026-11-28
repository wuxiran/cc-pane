import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DEFAULT_CCCHAN_SETTINGS, FALLBACK_PET, useCCChanStore } from "@/stores/useCCChanStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { BotSummary } from "@/types/bot";
import type { TerminalStatusInfo } from "@/types";
import { botWithPet, CCChanApp } from "./CCChanApp";

const setFocus = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus, startDragging: vi.fn(() => Promise.resolve()) }),
}));

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();

function emitWebview(name: string, payload: unknown) {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
}

const BOT: BotSummary = {
  id: "b1",
  name: "小审",
  avatar: "🦉",
  color: "",
  persona: "",
  engineId: "claude",
  autoApproveKinds: [],
  createdAt: 0,
  updatedAt: 0,
  chatId: "bot-b1",
  effectiveCwd: "/tmp",
  petId: "homie",
};

function mockInvoke(options: { bots?: BotSummary[]; statuses?: TerminalStatusInfo[]; reply?: string } = {}) {
  vi.mocked(invoke).mockImplementation(((cmd: string) => {
    if (cmd === "get_ccchan_settings") return Promise.resolve(DEFAULT_CCCHAN_SETTINGS);
    if (cmd === "get_ccchan_pets") return Promise.resolve([FALLBACK_PET]);
    if (cmd === "get_all_terminal_status") return Promise.resolve(options.statuses ?? []);
    if (cmd === "list_bots") return Promise.resolve(options.bots ?? []);
    if (cmd === "get_acp_chat") return Promise.resolve(null);
    if (cmd === "ask_bot") return Promise.resolve({ text: options.reply ?? "好的", stopReason: "end_turn", botChatId: "bot-b1" });
    return Promise.resolve(undefined);
  }) as never);
}

function status(sessionId: string, value: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return { sessionId, status: value, lastOutputAt: 0, updatedAt: 1 };
}

describe("CCChanApp", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listeners.clear();
    await i18n.changeLanguage("zh-CN");
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.mocked(getCurrentWebview().listen).mockImplementation(async (name, handler) => {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(handler as Listener);
      listeners.set(name, set);
      return () => set.delete(handler as Listener);
    });
    useCCChanStore.setState({ settings: DEFAULT_CCCHAN_SETTINGS, pets: [FALLBACK_PET], loading: false, loaded: false });
    useTerminalStatusStore.setState({ statusMap: new Map(), _unlisten: null, _idleCheckInterval: null, _initialized: false });
  });

  it("asks the active bot through ask_bot and shows the single reply", async () => {
    mockInvoke({ bots: [BOT], reply: "这个 PR 可以合" });
    render(<CCChanApp />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_bots"));

    const pet = await screen.findByRole("button", { name: /小审/ });
    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });
    fireEvent.pointerUp(pet, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });

    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "看下 #12" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ask_bot", expect.objectContaining({
        botId: "b1",
        text: "看下 #12",
        fromChatId: "ccchan-pet",
      }));
    });
    expect(await screen.findByText("这个 PR 可以合")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /在主窗口查看完整/ }));
    expect(emitTo).toHaveBeenCalledWith("main", "ccchan:open-bot-chat", { botId: "b1" });
  });

  it("jumps to the most urgent session instead of asking", async () => {
    mockInvoke({ bots: [BOT], statuses: [status("s-wait", "waitingInput"), status("s-run", "thinking")] });
    render(<CCChanApp />);
    await waitFor(() => expect(useTerminalStatusStore.getState().statusMap.size).toBe(2));

    const pet = await screen.findByRole("button", { name: /等你输入/ });
    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });
    fireEvent.pointerUp(pet, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });

    expect(emitTo).toHaveBeenCalledWith("main", "ccchan:focus-session", { sessionId: "s-wait" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("guides to creating a bot when there is none", async () => {
    mockInvoke({ bots: [] });
    render(<CCChanApp />);
    const pet = await screen.findByRole("button", { name: /cc酱/ });
    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });
    fireEvent.pointerUp(pet, { button: 0, pointerId: 1, screenX: 5, screenY: 5 });
    expect(emitTo).toHaveBeenCalledWith("main", "ccchan:open-bots", { create: true });
    expect(await screen.findByText("还没有 Bot，先去建一个吧")).toBeInTheDocument();
  });

  it("names sessions in event bubbles from the main window directory", async () => {
    mockInvoke();
    render(<CCChanApp />);
    await waitFor(() => expect(listeners.get("ccchan-event")?.size).toBeGreaterThan(0));
    act(() => {
      emitWebview("ccchan:session-directory", { sessions: [{ sessionId: "abc-123456", title: "修复登录", viewed: false }] });
    });
    act(() => {
      emitWebview("ccchan-event", { kind: "task-complete", sessionId: "abc-123456", ok: true, ts: 0 });
    });
    expect(await screen.findByText("修复登录 完成")).toBeInTheDocument();
  });

  it("reports hit regions and applies pushed settings without resizing modes", async () => {
    mockInvoke();
    render(<CCChanApp />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_ccchan_hit_regions", expect.anything()));
    await waitFor(() => expect(listeners.get("ccchan:settings-updated")?.size).toBeGreaterThan(0));
    act(() => emitWebview("ccchan:settings-updated", { ...DEFAULT_CCCHAN_SETTINGS, petSize: 200 }));
    expect(useCCChanStore.getState().settings.petSize).toBe(200);
    expect(invoke).not.toHaveBeenCalledWith("set_ccchan_window_mode", expect.anything());
  });

  it("keeps the bot record intact when only the pet changes", () => {
    const bot = botWithPet(BOT, "doro.codex-pet");
    expect(bot).toMatchObject({ id: "b1", name: "小审", petId: "doro.codex-pet" });
    expect(bot).not.toHaveProperty("chatId");
    expect(bot).not.toHaveProperty("effectiveCwd");
  });
});
