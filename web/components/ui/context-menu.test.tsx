import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";

function TestContextMenu() {
  return (
    <ContextMenu>
      <ContextMenuTrigger>Open menu</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Action</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe("ContextMenu browser webview overlay", () => {
  beforeEach(() => {
    useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
  });

  it("blocks native browser webviews while the menu is open and restores them on close", async () => {
    const user = userEvent.setup();
    render(<TestContextMenu />);

    fireEvent.contextMenu(screen.getByText("Open menu"));

    await waitFor(() => {
      expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(1);
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(0);
    });
  });

  it("releases the native webview block if an open menu unmounts", async () => {
    const view = render(<TestContextMenu />);
    fireEvent.contextMenu(screen.getByText("Open menu"));
    await waitFor(() => {
      expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(1);
    });

    view.unmount();

    expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(0);
  });
});

describe("ContextMenu 键盘 Menu 键路径", () => {
  beforeEach(() => {
    useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
  });

  it("焦点在 trigger 自身时按 ContextMenu 键（Menu 键/Shift+F10）打开菜单", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger tabIndex={0}>菜单区域</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>动作</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.keyDown(screen.getByText("菜单区域"), { key: "ContextMenu" });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("Esc 关闭键盘打开的菜单", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger tabIndex={0}>菜单区域</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>动作</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.keyDown(screen.getByText("菜单区域"), { key: "ContextMenu" });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("事件从后代元素冒泡时封装不介入（使用方容器级实现如 filetree 不会双开）", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span data-testid="row">文件行</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>动作</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.keyDown(screen.getByTestId("row"), { key: "ContextMenu" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("使用方 onKeyDown 先执行且 preventDefault 时封装让路", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu") event.preventDefault();
          }}
        >
          菜单区域
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>动作</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.keyDown(screen.getByText("菜单区域"), { key: "ContextMenu" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

