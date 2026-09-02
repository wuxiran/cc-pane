import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFullscreenStore, usePanesStore, useSettingsStore, useTerminalStatusStore } from "@/stores";
import { createPanel } from "@/lib/paneTree";
import type { PaneNode } from "@/types";
import { createTestSettings } from "@/test/utils/testData";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import TerminalStatusBar from "./TerminalStatusBar";

vi.mock("@/components/ContextUsageIndicator", () => ({
  default: ({ enabled }: { enabled?: boolean }) => (
    <span data-testid="context-usage-indicator" data-enabled={String(enabled)} />
  ),
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

describe("TerminalStatusBar", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    useSettingsStore.setState({ settings: createTestSettings() });
    useTerminalStatusStore.setState({ statusMap: new Map() });
  });

  it("shows context usage by default", () => {
    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />,
    );

    expect(screen.getByTestId("terminal-status-bar")).toBeInTheDocument();
    expect(screen.getByTestId("context-usage-indicator")).toHaveAttribute("data-enabled", "true");
    expect(screen.getByRole("button", { name: "task-queue-session-1" })).toBeInTheDocument();
  });

  it("hides the queue entry when the global feature is disabled", () => {
    const settings = createTestSettings();
    useSettingsStore.setState({
      settings: {
        ...settings,
        terminal: { ...settings.terminal, taskQueueEnabled: false },
      },
    });

    render(<TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />);
    expect(screen.queryByRole("button", { name: "task-queue-session-1" })).not.toBeInTheDocument();
  });

  it("does not expose queue controls in a browser runtime", () => {
    window.__TAURI_INTERNALS__ = undefined;

    render(<TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />);
    expect(screen.queryByRole("button", { name: "task-queue-session-1" })).not.toBeInTheDocument();
  });

  it("does not expose queue controls without an eligible CLI session", () => {
    render(
      <TerminalStatusBar
        terminalContext={{ ...terminalContext, cliTool: "none" }}
        projectPath="/tmp/project"
      />,
    );
    expect(screen.queryByRole("button", { name: "task-queue-session-1" })).not.toBeInTheDocument();
  });

  it("hides only context usage when the terminal setting is disabled", () => {
    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />,
    );

    act(() => {
      const settings = useSettingsStore.getState().settings!;
      useSettingsStore.setState({
        settings: {
          ...settings,
          terminal: { ...settings.terminal, showContextUsage: false },
        },
      });
    });

    expect(screen.getByTestId("terminal-status-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("context-usage-indicator")).not.toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("collapses the whole bar when showStatusBar is disabled", () => {
    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />,
    );

    expect(screen.getByTestId("terminal-status-bar")).toBeInTheDocument();

    act(() => {
      const settings = useSettingsStore.getState().settings!;
      useSettingsStore.setState({
        settings: {
          ...settings,
          terminal: { ...settings.terminal, showStatusBar: false },
        },
      });
    });

    // 整段不渲染,空 DOM 也不要
    expect(screen.queryByTestId("terminal-status-bar")).not.toBeInTheDocument();
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-usage-indicator")).not.toBeInTheDocument();
  });

  it("toggles showStatusBar from the right-click menu", async () => {
    const user = userEvent.setup();
    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />,
    );

    expect(screen.getByTestId("terminal-status-bar")).toBeInTheDocument();

    await user.pointer({ target: screen.getByTestId("terminal-status-bar"), keys: "[MouseRight]" });

    const menuItem = await screen.findByText("隐藏状态栏");
    await user.click(menuItem);

    expect(useSettingsStore.getState().settings?.terminal.showStatusBar).toBe(false);
    expect(screen.queryByTestId("terminal-status-bar")).not.toBeInTheDocument();
  });
});

describe("TerminalStatusBar 焦点渐进展示", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    useSettingsStore.setState({ settings: createTestSettings() });
    useTerminalStatusStore.setState({ statusMap: new Map() });
    useFullscreenStore.setState({ isFullscreen: false, fullscreenPaneId: null });
  });

  function resetPanes(rootPane: PaneNode, activePaneId: string) {
    usePanesStore.setState({ rootPane, activePaneId });
  }

  function statusBarState() {
    return screen.getByTestId("terminal-status-bar").getAttribute("data-pane-statusbar");
  }

  it("单窗格永远全亮（无焦点歧义，不降透明度）", () => {
    const pane = createPanel();
    resetPanes(pane, pane.id);

    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" paneId={pane.id} />,
    );

    expect(statusBarState()).toBe("full");
  });

  it("多窗格时非焦点窗格状态条降为 dimmed", () => {
    const focused = createPanel();
    const blurred = createPanel();
    const root: PaneNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [focused, blurred],
      sizes: [50, 50],
    };
    resetPanes(root, focused.id);

    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" paneId={blurred.id} />,
    );

    expect(statusBarState()).toBe("dimmed");
  });

  it("多窗格时焦点窗格状态条保持全亮", () => {
    const focused = createPanel();
    const blurred = createPanel();
    const root: PaneNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [focused, blurred],
      sizes: [50, 50],
    };
    resetPanes(root, focused.id);

    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" paneId={focused.id} />,
    );

    expect(statusBarState()).toBe("full");
  });

  it("焦点切换后状态条即时恢复全亮", () => {
    const first = createPanel();
    const second = createPanel();
    const root: PaneNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [first, second],
      sizes: [50, 50],
    };
    resetPanes(root, first.id);

    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" paneId={second.id} />,
    );
    expect(statusBarState()).toBe("dimmed");

    act(() => {
      usePanesStore.setState({ activePaneId: second.id });
    });
    expect(statusBarState()).toBe("full");
  });

  it("全屏中的窗格状态条保持全亮", () => {
    const focused = createPanel();
    const fullscreen = createPanel();
    const root: PaneNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [focused, fullscreen],
      sizes: [50, 50],
    };
    resetPanes(root, focused.id);
    useFullscreenStore.setState({ isFullscreen: true, fullscreenPaneId: fullscreen.id });

    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" paneId={fullscreen.id} />,
    );

    expect(statusBarState()).toBe("full");
  });

  it("未传 paneId 时始终全亮（独立渲染场景向后兼容）", () => {
    const focused = createPanel();
    const blurred = createPanel();
    const root: PaneNode = {
      type: "split",
      id: "split-root",
      direction: "horizontal",
      children: [focused, blurred],
      sizes: [50, 50],
    };
    resetPanes(root, focused.id);

    render(
      <TerminalStatusBar terminalContext={terminalContext} projectPath="/tmp/project" />,
    );

    expect(statusBarState()).toBe("full");
  });
});
