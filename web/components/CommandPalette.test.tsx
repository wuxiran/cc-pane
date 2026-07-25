import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useActivityBarStore,
  useModulePrefsStore,
  usePanesStore,
  useQuickCommandsStore,
  useSettingsStore,
  useShortcutsStore,
  useWorkspacesStore,
} from "@/stores";
import type { QuickCommand } from "@/types";
import { createDefaultModulePreferences } from "@/stores/useModulePrefsStore";
import { MODULE_REGISTRY } from "@/modules/registry";
import CommandPalette, { COMMAND_PALETTE_TOGGLE_EVENT } from "./CommandPalette";

const executeQuickCommand = vi.fn();

vi.mock("@/lib/quickCommandExecution", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/quickCommandExecution")>();
  return {
    ...original,
    executeQuickCommand: (...args: unknown[]) => executeQuickCommand(...args),
  };
});

function quickCommand(id: string, name: string, text: string): QuickCommand {
  return {
    id,
    name,
    kind: "terminal",
    text,
    appendEnter: true,
    target: "currentPane",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}

describe("CommandPalette modules", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useShortcutsStore.setState({ actions: new Map(), terminalFocused: false });
    useSettingsStore.setState({
      settings: { shortcuts: { bindings: {} } },
    } as never);
    useWorkspacesStore.setState({ workspaces: [] });
    useActivityBarStore.setState({
      activeView: "explorer",
      sidebarVisible: true,
      appViewMode: "home",
      orchestrationOverlayOpen: false,
    });
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
    const tab = {
      id: "tab-quick",
      title: "Quick",
      contentType: "terminal" as const,
      projectId: "project-quick",
      projectPath: "/repo/quick",
      sessionId: "session-quick",
    };
    usePanesStore.setState({
      rootPane: {
        type: "panel",
        id: "pane-quick",
        tabs: [tab],
        activeTabId: tab.id,
      },
      activePaneId: "pane-quick",
    });
    useQuickCommandsStore.setState({
      globalCommands: [],
      projectCommands: [],
      commands: [],
      activeProjectPath: "/repo/quick",
      loading: false,
    });
    executeQuickCommand.mockReset();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  it("searches a quick command and closes before dispatching it", async () => {
    const user = userEvent.setup();
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    const deploy = quickCommand("deploy", "Deploy preview", "npm run deploy:preview");
    const lint = quickCommand("lint", "Lint", "npm run lint");
    useQuickCommandsStore.setState({
      commands: [
        { ...deploy, scope: "global" },
        { ...lint, scope: "project" },
      ],
    });
    executeQuickCommand.mockResolvedValue(undefined);
    render(<CommandPalette />);

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT)));
    const input = await screen.findByPlaceholderText(/命令|command/i);
    await user.type(input, "deploy preview");

    expect(screen.getByText("快捷命令")).toBeInTheDocument();
    expect(screen.getByText("Deploy preview")).toBeInTheDocument();
    expect(screen.queryByText("Lint")).not.toBeInTheDocument();

    await user.click(screen.getByText("Deploy preview"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(executeQuickCommand).not.toHaveBeenCalled();
    act(() => frameCallbacks.splice(0).forEach((callback) => callback(0)));

    expect(executeQuickCommand).toHaveBeenCalledWith(deploy, {
      paneId: "pane-quick",
      tab: expect.objectContaining({ id: "tab-quick" }),
    });
  });

  it("does not expose project commands from a different active project", async () => {
    useQuickCommandsStore.setState({
      activeProjectPath: "/repo/other",
      commands: [
        { ...quickCommand("global", "Global build", "npm run build"), scope: "global" },
        { ...quickCommand("project", "Other deploy", "npm run deploy"), scope: "project" },
      ],
    });
    render(<CommandPalette />);

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT)));

    expect(await screen.findByText("Global build")).toBeInTheDocument();
    expect(screen.queryByText("Other deploy")).not.toBeInTheDocument();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every registry module even when one is hidden", async () => {
    useModulePrefsStore.getState().setPosition("todo", "hidden");
    render(<CommandPalette />);

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT)));

    expect(await screen.findAllByTestId(/^module-command-/)).toHaveLength(MODULE_REGISTRY.length);
    expect(screen.getByTestId("module-command-todo")).toBeInTheDocument();
  });

  it("opens a hidden module from the command palette", async () => {
    const user = userEvent.setup();
    useModulePrefsStore.getState().setPosition("todo", "hidden");
    render(<CommandPalette />);

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT)));
    await user.click(await screen.findByTestId("module-command-todo"));

    expect(useActivityBarStore.getState().appViewMode).toBe("todo");
  });
});
