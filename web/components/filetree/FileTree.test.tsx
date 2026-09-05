import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileTreeStore, usePanesStore } from "@/stores";
import type { FileTreeNode as FileTreeNodeType, FsEntry } from "@/types/filesystem";
import FileTree from "./FileTree";

beforeAll(() => {
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

const ROOT = "/proj";

/** jsdom 布局恒为 0，虚拟化器会因 outerSize 为 0 一行不渲染；
 *  @tanstack/virtual-core 读的是 offsetHeight/offsetWidth，
 *  这里给滚动容器（app-scrollbar）一个固定视口高度。 */
function mockLayoutMetrics(viewportHeight = 600) {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList?.contains("app-scrollbar") ? viewportHeight : 28;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 300);
}

beforeEach(() => {
  mockLayoutMetrics();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function entry(path: string, isDir: boolean): FsEntry {
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
  };
}

function makeNode(
  e: FsEntry,
  opts: Partial<Omit<FileTreeNodeType, "entry">> = {}
): FileTreeNodeType {
  return { entry: e, children: null, expanded: false, loading: false, ...opts };
}

/** root -> src(expanded) -> deep(expanded) -> file.ts */
function sampleTree(): FileTreeNodeType {
  return makeNode(entry(ROOT, true), {
    expanded: true,
    children: [
      makeNode(entry(`${ROOT}/src`, true), {
        expanded: true,
        children: [
          makeNode(entry(`${ROOT}/src/deep`, true), {
            expanded: true,
            children: [makeNode(entry(`${ROOT}/src/deep/file.ts`, false))],
          }),
          makeNode(entry(`${ROOT}/src/other.ts`, false)),
        ],
      }),
      makeNode(entry(`${ROOT}/README.md`, false)),
    ],
  });
}

function setupStores(overrides: Record<string, unknown> = {}) {
  const actions = {
    loadDirectory: vi.fn().mockResolvedValue(undefined),
    toggleExpand: vi.fn().mockResolvedValue(undefined),
    loadGitStatuses: vi.fn().mockResolvedValue(undefined),
    setSelectedFilePath: vi.fn(),
  };
  useFileTreeStore.setState({
    trees: { [ROOT]: sampleTree() },
    gitStatuses: {},
    selectedFilePath: null,
    ...actions,
    ...overrides,
  });
  const openEditor = vi.fn();
  usePanesStore.setState({ openEditor });
  return { ...actions, openEditor };
}

describe("FileTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests the directory when the tree is absent and shows skeleton rows after the delay", () => {
    vi.useFakeTimers();
    try {
      const actions = setupStores({ trees: {} });
      render(<FileTree rootPath={ROOT} />);
      expect(actions.loadDirectory).toHaveBeenCalledWith(ROOT, ROOT);
      expect(actions.loadGitStatuses).toHaveBeenCalledWith(ROOT);
      // 300ms 内不显示骨架，避免快加载闪占位
      expect(screen.queryByTestId("file-tree-skeleton")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByTestId("file-tree-skeleton")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the loaded tree without re-requesting it", () => {
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);
    expect(screen.getByText("file.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(actions.loadDirectory).not.toHaveBeenCalled();
  });

  it("delegates directory toggling to the store", async () => {
    const user = userEvent.setup();
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);
    await user.click(screen.getByText("src"));
    expect(actions.toggleExpand).toHaveBeenCalledWith(ROOT, `${ROOT}/src`);
  });

  it("opens files in the panes editor by default and selects them", async () => {
    const user = userEvent.setup();
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);
    await user.click(screen.getByText("README.md"));
    expect(actions.openEditor).toHaveBeenCalledWith(ROOT, `${ROOT}/README.md`, "README.md");
    expect(actions.setSelectedFilePath).toHaveBeenCalledWith(`${ROOT}/README.md`);
  });

  it("uses the onOpenFile override instead of the default editor", async () => {
    const user = userEvent.setup();
    const actions = setupStores();
    const onOpenFile = vi.fn();
    render(<FileTree rootPath={ROOT} onOpenFile={onOpenFile} />);
    await user.click(screen.getByText("README.md"));
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}/README.md`, "README.md");
    expect(actions.openEditor).not.toHaveBeenCalled();
  });

  it("bubbles git status badges up to parent directories", () => {
    setupStores({
      gitStatuses: { [ROOT]: { [`${ROOT}/src/deep/file.ts`]: "modified" } },
    });
    render(<FileTree rootPath={ROOT} />);
    for (const name of ["file.ts", "deep", "src"]) {
      const row = screen.getByText(name).closest("div[data-file-path]") as HTMLElement;
      expect(row.querySelector('span[title="modified"]')).toHaveTextContent("M");
      expect(row.querySelector('span[title="modified"]')).toHaveClass(
        "text-[var(--app-status-warning)]",
      );
    }
    // 根目录本身（长度 <= rootPath）不冒泡
    const readmeRow = screen.getByText("README.md").closest("div[data-file-path]") as HTMLElement;
    expect(readmeRow.querySelector("span[title]")).toBeNull();
  });

  it("keeps the higher-priority git status when bubbling multiple children", () => {
    setupStores({
      gitStatuses: {
        [ROOT]: {
          [`${ROOT}/src/other.ts`]: "untracked",
          [`${ROOT}/src/deep/file.ts`]: "modified",
        },
      },
    });
    render(<FileTree rootPath={ROOT} />);
    // modified(3) 优先于 untracked(1)
    const srcRow = screen.getByText("src").closest("div[data-file-path]") as HTMLElement;
    const otherRow = screen.getByText("other.ts").closest("div[data-file-path]") as HTMLElement;
    expect(srcRow.querySelector('span[title="modified"]')).toHaveTextContent("M");
    expect(otherRow.querySelector('span[title="untracked"]')).toHaveTextContent("U");
  });

  it("syncs selection when the active pane switches to an editor tab", async () => {
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);

    usePanesStore.setState({
      activePaneId: "pane-1",
      rootPane: {
        type: "panel",
        id: "pane-1",
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "file.ts",
            contentType: "editor",
            filePath: `${ROOT}/src/deep/file.ts`,
          },
        ],
      } as never,
    });

    await waitFor(() => {
      expect(actions.setSelectedFilePath).toHaveBeenCalledWith(`${ROOT}/src/deep/file.ts`);
    });
  });
});

describe("FileTree keyboard navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getRow(name: string): HTMLElement {
    return screen.getByText(name).closest("div[data-file-path]") as HTMLElement;
  }

  it("renders a labelled tree with a single tabbable treeitem (roving tabindex)", () => {
    setupStores();
    render(<FileTree rootPath={ROOT} />);
    expect(screen.getByRole("tree")).toHaveAttribute("aria-label");
    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(6);
    const tabbable = items.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    // 默认聚焦首个可见项（根目录）
    expect(tabbable[0]).toBe(getRow("proj"));
  });

  it("moves focus with ArrowDown/ArrowUp across visible items only", () => {
    setupStores();
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getRow("src"));
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getRow("deep"));
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getRow("file.ts"));
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(document.activeElement).toBe(getRow("deep"));
  });

  it("ArrowRight enters the first child of an expanded directory", () => {
    setupStores();
    render(<FileTree rootPath={ROOT} />);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(getRow("src"));
  });

  it("ArrowRight expands a collapsed directory instead of moving focus", () => {
    const actions = setupStores();
    useFileTreeStore.setState({
      trees: {
        [ROOT]: makeNode(entry(ROOT, true), {
          expanded: true,
          children: [makeNode(entry(`${ROOT}/src`, true))],
        }),
      },
    });
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getRow("src"));
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(actions.toggleExpand).toHaveBeenCalledWith(ROOT, `${ROOT}/src`);
    expect(document.activeElement).toBe(getRow("src"));
  });

  it("ArrowLeft collapses an expanded directory and otherwise moves to the parent", () => {
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    // 根目录展开 → 折叠
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(actions.toggleExpand).toHaveBeenCalledWith(ROOT, ROOT);

    // 文件 → 回到父目录
    fireEvent.focus(getRow("file.ts"));
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(getRow("deep"));
  });

  it("Enter toggles directories and opens files like a mouse click", () => {
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    fireEvent.focus(getRow("src"));
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(actions.toggleExpand).toHaveBeenCalledWith(ROOT, `${ROOT}/src`);

    fireEvent.focus(getRow("README.md"));
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(actions.openEditor).toHaveBeenCalledWith(ROOT, `${ROOT}/README.md`, "README.md");
    expect(actions.setSelectedFilePath).toHaveBeenCalledWith(`${ROOT}/README.md`);
  });

  it("F2 opens the rename dialog for the focused node", async () => {
    setupStores();
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    fireEvent.focus(getRow("README.md"));
    fireEvent.keyDown(tree, { key: "F2" });
    expect(await screen.findByDisplayValue("README.md")).toBeInTheDocument();
  });

  it("Menu key opens the context menu for the focused node", async () => {
    setupStores();
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    fireEvent.focus(getRow("README.md"));
    fireEvent.keyDown(tree, { key: "ContextMenu" });
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
  });

  it("keeps mouse click behaviour intact while syncing the roving tabindex", async () => {
    const user = userEvent.setup();
    const actions = setupStores();
    render(<FileTree rootPath={ROOT} />);

    await user.click(screen.getByText("src"));
    expect(actions.toggleExpand).toHaveBeenCalledWith(ROOT, `${ROOT}/src`);

    fireEvent.focus(getRow("README.md"));
    expect(getRow("README.md")).toHaveAttribute("tabindex", "0");
    expect(getRow("proj")).toHaveAttribute("tabindex", "-1");
  });
});

describe("FileTree virtualization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 根目录下 500 个文件的大平铺目录 */
  function bigTree(count: number): FileTreeNodeType {
    return makeNode(entry(ROOT, true), {
      expanded: true,
      children: Array.from({ length: count }, (_, i) =>
        makeNode(entry(`${ROOT}/file-${String(i).padStart(3, "0")}.ts`, false)),
      ),
    });
  }

  it("renders only the visible window of rows for a large directory", () => {
    setupStores({ trees: { [ROOT]: bigTree(500) } });
    render(<FileTree rootPath={ROOT} />);

    const rendered = screen.getAllByRole("treeitem");
    // 600px 视口 / 28px 行高 + overscan，远小于总数
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
    expect(screen.queryByText("file-499.ts")).not.toBeInTheDocument();
    // 语义不省：总行数通过 aria-setsize 暴露
    expect(rendered[0]).toHaveAttribute("aria-setsize", "501");
    expect(rendered[0]).toHaveAttribute("aria-posinset", "1");
  });

  it("renders the tail rows after scrolling to the bottom", () => {
    setupStores({ trees: { [ROOT]: bigTree(500) } });
    render(<FileTree rootPath={ROOT} />);

    const tree = screen.getByRole("tree");
    tree.scrollTop = 28 * 500; // 直接跳到底部
    fireEvent.scroll(tree);

    expect(screen.getByText("file-499.ts")).toBeInTheDocument();
    expect(screen.queryByText("file-000.ts")).not.toBeInTheDocument();
    const rendered = screen.getAllByRole("treeitem");
    expect(rendered.length).toBeLessThan(60);
  });

  it("moves keyboard focus into a row brought in by scrollToIndex", () => {
    setupStores({ trees: { [ROOT]: bigTree(50) } });
    render(<FileTree rootPath={ROOT} />);
    const tree = screen.getByRole("tree");

    // 从根目录一路 ↓ 穿过整个 600px 视口仍可达的项（50 项全部在 600px*2 内，先滚动模拟）
    tree.scrollTop = 28 * 40;
    fireEvent.scroll(tree);

    fireEvent.focus(screen.getByText("file-040.ts"));
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByText("file-041.ts").closest("div[data-file-path]"),
    );
  });
});
