import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCommandsStore } from "@/lib/commands/registry";
import { useSettingsStore, useShortcutsStore } from "@/stores";
import type { CommandDescriptor } from "@/lib/commands/types";
import CommandMenuItem from "./CommandMenuItem";

function makeCommand(partial: Partial<CommandDescriptor> & { id: string }): CommandDescriptor {
  return { group: "system", run: vi.fn(), ...partial };
}

function renderMenu(item: React.ReactNode) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>trigger-zone</ContextMenuTrigger>
      <ContextMenuContent>{item}</ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("trigger-zone"));
}

beforeEach(() => {
  useCommandsStore.setState({ commands: new Map() });
  useShortcutsStore.setState({ actions: new Map(), terminalFocused: false });
  useSettingsStore.setState({
    settings: { shortcuts: { bindings: {} } },
  } as never);
});

describe("CommandMenuItem", () => {
  it("命令未注册时不渲染", async () => {
    renderMenu(<CommandMenuItem commandId="missing" />);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("显示标题与当前键位，点击后带 ctx 执行", async () => {
    const run = vi.fn();
    useCommandsStore.getState().registerCommands([
      makeCommand({ id: "split-right", titleKey: "split-right", run }),
    ]);
    useSettingsStore.setState({
      settings: { shortcuts: { bindings: { "split-right": "Ctrl+\\" } } },
    } as never);

    renderMenu(<CommandMenuItem commandId="split-right" ctx={{ paneId: "pane-9" }} />);

    const item = await screen.findByRole("menuitem");
    expect(item.textContent).toContain("向右分屏");
    expect(item.textContent).toContain("Ctrl+\\");

    fireEvent.click(item);
    expect(run).toHaveBeenCalledWith({ paneId: "pane-9" });
  });

  it("when 返回 false 时菜单项置灰", async () => {
    useCommandsStore.getState().registerCommands([
      makeCommand({ id: "gated", title: "受控命令", when: () => false }),
    ]);

    renderMenu(<CommandMenuItem commandId="gated" />);

    const item = await screen.findByRole("menuitem");
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("label 覆盖全局命令标题（菜单内文案可不同）", async () => {
    useCommandsStore.getState().registerCommands([
      makeCommand({ id: "split-right", titleKey: "split-right" }),
    ]);

    renderMenu(<CommandMenuItem commandId="split-right" label="面板 · 拆分到右侧" />);

    const item = await screen.findByRole("menuitem");
    expect(item.textContent).toContain("面板 · 拆分到右侧");
    expect(item.textContent).not.toContain("向右分屏");
  });
});
