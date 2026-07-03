import { render, screen } from "@testing-library/react";
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
  render(
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
  return handlers;
}

describe("getFileIcon", () => {
  it("returns a generic file icon when extension is null", () => {
    const { container } = render(<>{getFileIcon(null)}</>);
    expect(container.querySelector("svg.lucide-file")).not.toBeNull();
  });

  it("is case-insensitive for known extensions", () => {
    const { container } = render(<>{getFileIcon("JSON")}</>);
    // JSON 分支使用 FileJson 图标 + text-yellow-500
    expect(container.querySelector("svg.text-yellow-500")).not.toBeNull();
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

  it("forwards contextmenu events with the node", async () => {
    const node = makeNode(entry("/proj/a.ts", false));
    const handlers = renderNode(node);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(screen.getByText("a.ts"));
    expect(handlers.onContextMenu).toHaveBeenCalledWith(expect.anything(), node);
  });

  it("renders chevron by expanded state and a spinner while loading", () => {
    const { container: collapsed } = render(
      <FileTreeNode
        node={makeNode(entry("/proj/src", true))}
        depth={0}
        rootPath="/proj"
        onToggle={vi.fn()}
        onFileClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    expect(collapsed.querySelector("svg.lucide-chevron-right")).not.toBeNull();

    const { container: loading } = render(
      <FileTreeNode
        node={makeNode(entry("/proj/src", true), { loading: true })}
        depth={0}
        rootPath="/proj"
        onToggle={vi.fn()}
        onFileClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    expect(loading.querySelector("svg.lucide-loader-circle, svg.lucide-loader-2")).not.toBeNull();
  });

  it("renders children recursively when the directory is expanded", () => {
    const tree = makeNode(entry("/proj/src", true), {
      expanded: true,
      children: [
        makeNode(entry("/proj/src/a.ts", false)),
        makeNode(entry("/proj/src/sub", true)),
      ],
    });
    renderNode(tree);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
  });

  it("applies git status color classes to the file name", () => {
    renderNode(makeNode(entry("/proj/a.ts", false)), {
      gitStatuses: { "/proj/a.ts": "modified" },
    });
    expect(screen.getByText("a.ts")).toHaveClass("text-yellow-400");
  });

  it("highlights the selected file", () => {
    renderNode(makeNode(entry("/proj/a.ts", false)), {
      selectedFilePath: "/proj/a.ts",
    });
    const row = screen.getByText("a.ts").closest("div[data-file-path]") as HTMLElement;
    expect(row.className).toContain("bg-[var(--editor-selection-bg)]");
  });

  it("indents by depth", () => {
    render(
      <FileTreeNode
        node={makeNode(entry("/proj/deep.ts", false))}
        depth={3}
        rootPath="/proj"
        onToggle={vi.fn()}
        onFileClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    const row = screen.getByText("deep.ts").closest("div[data-file-path]") as HTMLElement;
    expect(row.style.paddingLeft).toBe("54px"); // 3 * 14 + 12
  });
});
