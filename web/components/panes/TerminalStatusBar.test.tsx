import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore, useTerminalStatusStore } from "@/stores";
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
