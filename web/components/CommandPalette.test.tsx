import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useActivityBarStore,
  useModulePrefsStore,
  useSettingsStore,
  useShortcutsStore,
  useWorkspacesStore,
} from "@/stores";
import { createDefaultModulePreferences } from "@/stores/useModulePrefsStore";
import CommandPalette, { COMMAND_PALETTE_TOGGLE_EVENT } from "./CommandPalette";

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
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists all five registry modules even when one is hidden", async () => {
    useModulePrefsStore.getState().setPosition("todo", "hidden");
    render(<CommandPalette />);

    act(() => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT)));

    expect(await screen.findAllByTestId(/^module-command-/)).toHaveLength(5);
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
