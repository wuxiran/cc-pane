import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FileTreeNode as FileTreeNodeType, FsEntry } from "@/types/filesystem";
import FileTreeNode, { getFileIcon } from "./FileTreeNode";

function entry(path: string, isDir: boolean, overrides: Partial<FsEntry> = {}): FsEntry {
  const name = path.split(/[/\\]/).pop() || path;
  return {
    name,
    path,
    isDir,
    isFile: !isDir,
    isSymlink: false,
    size: 0,
    modified: null,
    extension: isDir ? null : name.includes(".") ? name.split(".").pop()! : null,
    hidden: false,
    ...overrides,
  };
}

function makeNode(
  e: FsEntry,
  opts: Partial<Omit<FileTreeNodeType, "entry">> = {}
): FileTreeNodeType {
  return { entry: e, children: null, expanded: false, loading: false, ...opts };
}

function renderNode(node: FileTreeNodeType, extra: Record<string, unknown> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onFileClick: vi.fn(),
    onContextMenu: vi.fn(),
  };
  const view = render(
    <FileTreeNode
      node={node}
      depth={0}
      rootPath="/proj"
      onToggle={handlers.onToggle}
      onFileClick={handlers.onFileClick}
      onContextMenu={handlers.onContextMenu}
      {...extra}
    />
  );
  return { ...handlers, unmount: view.unmount };
}

describe("getFileIcon", () => {
  it("returns a generic file icon when extension is null", () => {
    const { container } = render(<>{getFileIcon(null)}</>);
    expect(container.querySelector("svg.lucide-file")).not.toBeNull();
  });

  it("is case-insensitive for known extensions", () => {
    const { container: upper } = render(<>{getFileIcon("JSON")}</>);
    const { container: lower } = render(<>{getFileIcon("json")}</>);
    const icon = upper.querySelector("svg");
    expect(icon).not.toHaveClass("lucide-file");
    expect(icon?.getAttribute("class")).toBe(lower.querySelector("svg")?.getAttribute("class"));
  });

  it("maps shell scripts to the terminal icon and unknown extensions to the fallback", () => {
    const { container: sh } = render(<>{getFileIcon("sh")}</>);
    expect(sh.querySelector("svg.lucide-terminal")).not.toBeNull();
    const { container: unknown } = render(<>{getFileIcon("xyz")}</>);
    expect(unknown.querySelector("svg.lucide-file")).not.toBeNull();
  });
});

describe("FileTreeNode", () => {
  it("toggles a directory on click instead of opening it", async () => {
    const user = userEvent.setup();
    const handlers = renderNode(makeNode(entry("/proj/src", true)));
    await user.click(screen.getByText("src"));
    expect(handlers.onToggle).toHaveBeenCalledWith("/proj/src");
    expect(handlers.onFileClick).not.toHaveBeenCalled();
  });

  it("opens a file on click", async () => {
    const user = userEvent.setup();
    const handlers = renderNode(makeNode(entry("/proj/a.ts", false)));
    await user.click(screen.getByText("a.ts"));
    expect(handlers.onFileClick).toHaveBeenCalledWith("/proj/a.ts");
    expect(handlers.onToggle).not.toHaveBeenCalled();
  });

  it("fires onDirDoubleClick only for directories", async () => {
    const user = userEvent.setup();
    const onDirDoubleClick = vi.fn();
    renderNode(makeNode(entry("/proj/src", true)), { onDirDoubleClick });
    await user.dblClick(screen.getByText("src"));
    expect(onDirDoubleClick).toHaveBeenCalledWith("/proj/src");
  });

  it("forwards contextmenu events with the node", () => {
    const node = makeNode(entry("/proj/a.ts", false));
    const handlers = renderNode(node);
    fireEvent.contextMenu(screen.getByText("a.ts"));
    expect(handlers.onContextMenu).toHaveBeenCalledWith(expect.anything(), node);
  });

  it("renders chevron by expanded state and a spinner while loading", () => {
    const { unmount } = renderNode(makeNode(entry("/proj/src", true)));
    expect(document.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    unmount();

    renderNode(makeNode(entry("/proj/src", true), { loading: true }));
    expect(document.querySelector("svg.lucide-loader-circle, svg.lucide-loader-2")).not.toBeNull();
  });

  it("exposes setsize/posinset semantics when rendered as a virtualized flat row", () => {
    renderNode(makeNode(entry("/proj/a.ts", false)), { posInSet: 3, setSize: 42 });
    const row = screen.getByRole("treeitem");
    expect(row).toHaveAttribute("aria-posinset", "3");
    expect(row).toHaveAttribute("aria-setsize", "42");
  });

  it.each([
    ["modified", "M", "text-[var(--app-status-warning)]"],
    ["untracked", "U", "text-[var(--app-status-success)]"],
    ["deleted", "D", "text-[var(--app-status-danger)]"],
  ])("renders %s as a status-colored letter badge", (status, letter, colorClass) => {
    renderNode(makeNode(entry("/proj/a.ts", false)), {
      gitStatuses: { "/proj/a.ts": status },
    });

    expect(screen.getByText(letter)).toHaveClass(colorClass);
    expect(screen.getByText(letter)).toHaveAttribute("title", status);
  });

  it("indents by depth", () => {
    renderNode(makeNode(entry("/proj/deep.ts", false)), { depth: 3 });
    const row = screen.getByText("deep.ts").closest("div[data-file-path]") as HTMLElement;
    expect(row.style.paddingLeft).toBe("54px"); // 3 * 14 + 12
  });

  it("exposes treeitem semantics: level, expanded state and roving tabindex", () => {
    renderNode(makeNode(entry("/proj/src", true), { expanded: true }), {
      focusedPath: "/proj/src",
    });
    const row = screen.getByRole("treeitem");
    expect(row).toHaveAttribute("aria-level", "1");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("keeps files free of aria-expanded and non-focused rows out of the tab order", () => {
    renderNode(makeNode(entry("/proj/a.ts", false)), { focusedPath: "/proj/other" });
    const row = screen.getByRole("treeitem");
    expect(row).not.toHaveAttribute("aria-expanded");
    expect(row).toHaveAttribute("tabindex", "-1");
  });

  it("marks the selected file via aria-selected", () => {
    renderNode(makeNode(entry("/proj/a.ts", false)), {
      selectedFilePath: "/proj/a.ts",
    });
    const row = screen.getByRole("treeitem");
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("data-current", "true");
  });

  it("reports focus to keep the roving tabindex in sync", () => {
    const onFocusNode = vi.fn();
    renderNode(makeNode(entry("/proj/a.ts", false)), { onFocusNode });
    const row = screen.getByRole("treeitem");
    row.focus();
    expect(onFocusNode).toHaveBeenCalledWith("/proj/a.ts");
  });
});
