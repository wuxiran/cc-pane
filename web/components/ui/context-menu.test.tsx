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
