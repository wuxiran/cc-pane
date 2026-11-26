import { TERMINAL_REPAIR_DISPLAY_EVENT } from "./terminalFitEvents";
import "@/i18n";
import i18n from "i18next";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFullscreenStore, usePanesStore, useSettingsStore, useTerminalStatusStore } from "@/stores";
import { createPanel } from "@/lib/paneTree";
import type { PaneNode } from "@/types";
import { createTestSettings } from "@/test/utils/testData";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import TerminalStatusBar from "./TerminalStatusBar";

vi.mock("@/components/ContextUsageIndicator", () => ({
  default: () => <span data-testid="context-usage-indicator" />,
}));

vi.mock("./SessionCostIndicator", () => ({
  default: () => <span data-testid="session-cost-indicator" />,
}));

vi.mock("./TaskQueuePopover", () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <button type="button" aria-label={`task-queue-${sessionId}`} />
  ),
}));

vi.mock("@/services/settingsService", () => ({
  settingsService: {
    updateSettings: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
}));

const terminalContext: ActiveTerminalContext = {
  sessionId: "session-1",
  cliTool: "claude",
  ssh: false,
  providerId: null,
  modelId: "claude-sonnet",
  providerSelection: null,
  launchProfileId: null,
};

type BarProps = Partial<React.ComponentProps<typeof TerminalStatusBar>>;

function renderBar(props: BarProps = {}) {
  return render(<TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" {...props} />);
}

function setTerminalSettings(patch: Partial<ReturnType<typeof createTestSettings>["terminal"]>) {
  const settings = useSettingsStore.getState().settings ?? createTestSettings();
  useSettingsStore.setState({ settings: { ...settings, terminal: { ...settings.terminal, ...patch } } });
}

const reviewButton = () => screen.queryByRole("button", { name: i18n.t("review:title") });
const queueButton = () => screen.queryByRole("button", { name: "task-queue-session-1" });

beforeEach(() => {
  window.__TAURI_INTERNALS__ = {};
  useSettingsStore.setState({ settings: createTestSettings() });
  useTerminalStatusStore.setState({ statusMap: new Map() });
});

describe("TerminalStatusBar", () => {
  it("opens review for the current CLI session and excludes remote files", async () => {
    const openReview = vi.spyOn(usePanesStore.getState(), "openReviewTab").mockReturnValue("review-tab");
    const rendered = renderBar({ projectPath: "/repo/worktree" });
    await userEvent.click(reviewButton()!);
    expect(openReview).toHaveBeenCalledWith("/repo/worktree", { checkpointChatId: "cli:session-1", cliSessionId: "session-1", paneId: undefined });
    openReview.mockRestore();
    rendered.rerender(<TerminalStatusBar terminalContext={{ ...terminalContext, ssh: true }} projectPath="/remote" />);
    expect(reviewButton()).not.toBeInTheDocument();
  });

  it("never opens host repository review for a WSL session", () => {
    renderBar({ projectPath: "C:/repo", wsl: true });
    expect(reviewButton()).not.toBeInTheDocument();
  });

  it("修复显示按钮把请求派发给当前会话", () => {
    const seen: unknown[] = [];
    const onRepair = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(TERMINAL_REPAIR_DISPLAY_EVENT, onRepair);
    renderBar({ projectPath: "/repo" });
    fireEvent.click(screen.getByTestId("terminal-repair-display"));
    window.removeEventListener(TERMINAL_REPAIR_DISPLAY_EVENT, onRepair);
    expect(seen).toEqual([{ sessionId: "session-1" }]);
  });

  it("shows context usage and the queue entry by default", () => {
    renderBar();
    expect(screen.getByTestId("context-usage-indicator")).toBeInTheDocument();
    expect(queueButton()).toBeInTheDocument();
  });

  it.each<[string, () => void, BarProps]>([
    ["the global feature is disabled", () => setTerminalSettings({ taskQueueEnabled: false }), {}],
    ["running in a browser runtime", () => { window.__TAURI_INTERNALS__ = undefined; }, {}],
    ["there is no eligible CLI session", () => {}, { terminalContext: { ...terminalContext, cliTool: "none" } }],
  ])("hides the queue entry when %s", (_label, arrange, props) => {
    arrange();
    renderBar(props);
    expect(queueButton()).not.toBeInTheDocument();
  });

  it("hides only context usage when the terminal setting is disabled", () => {
    renderBar();
    act(() => setTerminalSettings({ showContextUsage: false }));

    expect(screen.getByTestId("terminal-status-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("context-usage-indicator")).not.toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("toggles showStatusBar from the right-click menu and collapses the whole bar", async () => {
    const user = userEvent.setup();
    renderBar();

    await user.pointer({ target: screen.getByTestId("terminal-status-bar"), keys: "[MouseRight]" });
    await user.click(await screen.findByText("隐藏状态栏"));

    expect(useSettingsStore.getState().settings?.terminal.showStatusBar).toBe(false);
    // 整段不渲染,空 DOM 也不要
    expect(screen.queryByTestId("terminal-status-bar")).not.toBeInTheDocument();
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
  });
});

describe("TerminalStatusBar 焦点渐进展示", () => {
  beforeEach(() => {
    useFullscreenStore.setState({ isFullscreen: false, fullscreenPaneId: null });
  });

  /** 两格水平分屏，first 为焦点。 */
  function setupSplit() {
    const first = createPanel();
    const second = createPanel();
    const root: PaneNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [first, second],
      sizes: [50, 50],
    };
    usePanesStore.setState({ rootPane: root, activePaneId: first.id });
    return { first, second };
  }

  function statusBarState() {
    return screen.getByTestId("terminal-status-bar").getAttribute("data-pane-statusbar");
  }

  it("单窗格永远全亮（无焦点歧义，不降透明度）", () => {
    const pane = createPanel();
    usePanesStore.setState({ rootPane: pane, activePaneId: pane.id });
    renderBar({ paneId: pane.id });
    expect(statusBarState()).toBe("full");
  });

  it.each<[string, "focused" | "blurred" | "none", "full" | "dimmed"]>([
    ["多窗格时非焦点窗格状态条降为 dimmed", "blurred", "dimmed"],
    ["多窗格时焦点窗格状态条保持全亮", "focused", "full"],
    ["未传 paneId 时始终全亮（独立渲染场景向后兼容）", "none", "full"],
  ])("%s", (_label, which, expected) => {
    const { first, second } = setupSplit();
    const paneId = which === "focused" ? first.id : which === "blurred" ? second.id : undefined;
    renderBar({ paneId });
    expect(statusBarState()).toBe(expected);
  });

  it("焦点切换后状态条即时恢复全亮", () => {
    const { second } = setupSplit();
    renderBar({ paneId: second.id });
    expect(statusBarState()).toBe("dimmed");

    act(() => {
      usePanesStore.setState({ activePaneId: second.id });
    });
    expect(statusBarState()).toBe("full");
  });

  it("全屏中的窗格状态条保持全亮", () => {
    const { second } = setupSplit();
    useFullscreenStore.setState({ isFullscreen: true, fullscreenPaneId: second.id });
    renderBar({ paneId: second.id });
    expect(statusBarState()).toBe("full");
  });
});
