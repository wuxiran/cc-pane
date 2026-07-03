import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import FileExplorerToolbar from "./FileExplorerToolbar";

beforeAll(() => {
  // Radix Tooltip 依赖 ResizeObserver，jsdom 未实现
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

function renderToolbar(showHidden = false) {
  const handlers = {
    onRefresh: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onToggleHidden: vi.fn(),
  };
  render(<FileExplorerToolbar showHidden={showHidden} {...handlers} />);
  return handlers;
}

describe("FileExplorerToolbar", () => {
  it("renders four action buttons", () => {
    renderToolbar();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("wires refresh / new file / new folder / toggle hidden callbacks in order", async () => {
    const user = userEvent.setup();
    const handlers = renderToolbar();
    const [refresh, newFile, newFolder, toggleHidden] = screen.getAllByRole("button");

    await user.click(refresh);
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1);

    await user.click(newFile);
    expect(handlers.onNewFile).toHaveBeenCalledTimes(1);

    await user.click(newFolder);
    expect(handlers.onNewFolder).toHaveBeenCalledTimes(1);

    await user.click(toggleHidden);
    expect(handlers.onToggleHidden).toHaveBeenCalledTimes(1);
  });

  it("switches the hidden-files icon by showHidden state", () => {
    const { unmount } = render(
      <FileExplorerToolbar
        showHidden={false}
        onRefresh={vi.fn()}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
        onToggleHidden={vi.fn()}
      />
    );
    let toggle = screen.getAllByRole("button")[3];
    expect(toggle.querySelector("svg.lucide-eye-off")).not.toBeNull();
    unmount();

    render(
      <FileExplorerToolbar
        showHidden
        onRefresh={vi.fn()}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
        onToggleHidden={vi.fn()}
      />
    );
    toggle = screen.getAllByRole("button")[3];
    expect(toggle.querySelector("svg.lucide-eye")).not.toBeNull();
  });
});
