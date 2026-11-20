import "@/i18n";
import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { islandService } from "@/services/islandService";
import {
  DEFAULT_ISLAND_SETTINGS,
  ISLAND_ENV_EVENT,
  ISLAND_STATE_EVENT,
  type IslandSession,
  type IslandSnapshot,
} from "@/types/island";
import IslandApp from "./IslandApp";
import { COLLAPSE_DELAY_MS } from "./useHoverExpand";

const handlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@/services/islandService", () => ({
  islandService: {
    getState: vi.fn(),
    setLayout: vi.fn(() => Promise.resolve()),
    activateSession: vi.fn(() => Promise.resolve()),
    getTerminalPendingApproval: vi.fn(),
    respondPermission: vi.fn(() => Promise.resolve()),
    requestState: vi.fn(() => Promise.resolve()),
    listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return Promise.resolve(() => handlers.delete(event));
    }),
  },
}));

const session = (patch: Partial<IslandSession>): IslandSession => ({
  id: "s1", kind: "terminal", name: "bot-fix", cli: "Claude", state: "running",
  since: Date.now() - 60_000, activity: null, approval: null, ...patch,
});

const chatNeeds = session({
  id: "chat-1",
  kind: "chat",
  name: "dock-chat-2",
  state: "needs",
  approval: {
    requestKey: "req-1",
    title: "想要运行一个命令",
    detail: "npm run tauri:dev",
    options: [
      { optionId: "once", name: "批准一次", kind: "allow_once" },
      { optionId: "always", name: "本项目内总是允许 npm run", kind: "allow_always" },
      { optionId: "no", name: "拒绝，并告诉它怎么做", kind: "reject_once" },
    ],
    responding: false,
    error: null,
    queued: 0,
  },
});

function push(snapshot: IslandSnapshot) {
  act(() => handlers.get(ISLAND_STATE_EVENT)?.({ payload: snapshot }));
}

async function mount() {
  render(<IslandApp />);
  await waitFor(() => expect(handlers.has(ISLAND_STATE_EVENT)).toBe(true));
}

describe("IslandApp", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    vi.mocked(islandService.getState).mockResolvedValue({ settings: DEFAULT_ISLAND_SETTINGS, env: { fullscreen: false, mainFocused: false } });
    await i18n.changeLanguage("zh-CN");
  });
  afterEach(() => vi.useRealTimers());

  it("asks the main window for a snapshot once its listeners are ready and starts idle", async () => {
    await mount();
    await waitFor(() => expect(islandService.requestState).toHaveBeenCalled());
    expect(screen.getByText("cc")).toBeInTheDocument();
  });

  it("shows needs-you over running in the collapsed pill", async () => {
    await mount();
    push({ sessions: [session({}), chatNeeds], quota: null });
    expect(screen.getByText("dock-chat-2 · Claude 等你批准")).toBeInTheDocument();
    expect(screen.getByText("+1 运行")).toBeInTheDocument();
  });

  it("expands on hover, opens the approval card and answers with number keys via the main-window path", async () => {
    await mount();
    push({ sessions: [chatNeeds], quota: null });
    fireEvent.pointerEnter(screen.getByTestId("island-root"));
    expect(screen.getByText("需要你 · 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("dock-chat-2"));
    expect(screen.getByText("npm run tauri:dev")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining([
      "批准一次1", "本项目内总是允许 npm run2", "拒绝，并告诉它怎么做3",
    ]));
    fireEvent.keyDown(window, { key: "2" });
    expect(islandService.respondPermission).toHaveBeenCalledWith({ chatId: "chat-1", requestKey: "req-1", optionId: "always" });
    fireEvent.keyDown(window, { key: "9" });
    expect(islandService.respondPermission).toHaveBeenCalledTimes(1);
  });

  it("offers only jump-to-pane for a terminal session waiting for input", async () => {
    vi.mocked(islandService.getTerminalPendingApproval).mockResolvedValue("Would you like to run the following command?");
    await mount();
    push({ sessions: [session({ state: "needs" })], quota: null });
    fireEvent.pointerEnter(screen.getByTestId("island-root"));
    fireEvent.click(screen.getByText("bot-fix"));
    expect(await screen.findByText("Would you like to run the following command?")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "1" });
    expect(islandService.respondPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("在窗格里看"));
    expect(islandService.activateSession).toHaveBeenCalledWith({ kind: "terminal", id: "s1" });
  });

  it("clicking a running row navigates to its pane", async () => {
    await mount();
    push({ sessions: [session({ activity: "cargo test -p cc-panes-core" })], quota: null });
    fireEvent.pointerEnter(screen.getByTestId("island-root"));
    fireEvent.click(screen.getByText("cargo test -p cc-panes-core"));
    expect(islandService.activateSession).toHaveBeenCalledWith({ kind: "terminal", id: "s1" });
  });

  it("collapses 600ms after the pointer leaves", async () => {
    await mount();
    push({ sessions: [session({})], quota: null });
    vi.useFakeTimers();
    const root = screen.getByTestId("island-root");
    fireEvent.pointerEnter(root);
    expect(screen.getByText("运行中 · 1")).toBeInTheDocument();
    fireEvent.pointerLeave(root);
    act(() => vi.advanceTimersByTime(COLLAPSE_DELAY_MS - 1));
    expect(screen.getByText("运行中 · 1")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("运行中 · 1")).not.toBeInTheDocument();
    expect(screen.getByText("1 个会话运行中")).toBeInTheDocument();
  });

  it("shrinks to an amber line over full-screen apps", async () => {
    const { container } = render(<IslandApp />);
    await waitFor(() => expect(handlers.has(ISLAND_ENV_EVENT)).toBe(true));
    push({ sessions: [chatNeeds], quota: null });
    act(() => handlers.get(ISLAND_ENV_EVENT)?.({ payload: { fullscreen: true, mainFocused: false } }));
    const line = container.querySelector(".island-line");
    expect(line).toHaveAttribute("data-tone", "needs");
  });

  it("renders quota bars from the freshest snapshot", async () => {
    await mount();
    push({
      sessions: [],
      quota: { provider: "Codex", windows: [{ slot: "secondary", usedPercent: 35, windowMinutes: 10080, resetsAt: null }] },
    });
    fireEvent.pointerEnter(screen.getByTestId("island-root"));
    expect(screen.getByText("Codex · 本周")).toBeInTheDocument();
    expect(screen.getByText("35%")).toBeInTheDocument();
  });
});
