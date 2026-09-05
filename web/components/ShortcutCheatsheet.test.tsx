import "@/i18n";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandsStore } from "@/lib/commands/registry";
import { useSettingsStore, useShortcutsStore } from "@/stores";
import type { CommandDescriptor } from "@/lib/commands/types";
import ShortcutCheatsheet, { SHORTCUT_CHEATSHEET_TOGGLE_EVENT } from "./ShortcutCheatsheet";

function makeCommand(partial: Partial<CommandDescriptor> & { id: string }): CommandDescriptor {
  return { group: "system", run: vi.fn(), ...partial };
}

beforeEach(() => {
  useCommandsStore.setState({ commands: new Map() });
  useShortcutsStore.setState({ actions: new Map(), terminalFocused: false });
  useSettingsStore.setState({
    settings: { shortcuts: { bindings: {} } },
  } as never);
});

describe("ShortcutCheatsheet", () => {
  it("按组分节渲染命令与键位，事件切换开合", async () => {
    useCommandsStore.setState({
      commands: new Map([
        ["split-right", makeCommand({ id: "split-right", titleKey: "split-right", group: "layout" })],
        ["close-tab", makeCommand({ id: "close-tab", titleKey: "close-tab", group: "tab" })],
      ]),
    });
    useSettingsStore.setState({
      settings: { shortcuts: { bindings: { "split-right": "Ctrl+\\" } } },
    } as never);

    render(<ShortcutCheatsheet />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(SHORTCUT_CHEATSHEET_TOGGLE_EVENT)));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("布局操作")).toBeInTheDocument();
    expect(screen.getByText("标签页")).toBeInTheDocument();
    expect(screen.getByText("向右分屏")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+\\")).toBeInTheDocument();
    // 未绑定的命令显示占位符
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
