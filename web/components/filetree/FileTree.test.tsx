import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("shows a loading placeholder and requests the directory when the tree is absent", () => {
    const actions = setupStores({ trees: {} });
    render(<FileTree rootPath={ROOT} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(actions.loadDirectory).toHaveBeenCalledWith(ROOT, ROOT);
    expect(actions.loadGitStatuses).toHaveBeenCalledWith(ROOT);
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

  it("bubbles git status colors up to parent directories", () => {
    setupStores({
      gitStatuses: { [ROOT]: { [`${ROOT}/src/deep/file.ts`]: "modified" } },
    });
    render(<FileTree rootPath={ROOT} />);
    expect(screen.getByText("file.ts")).toHaveClass("text-yellow-400");
    expect(screen.getByText("deep")).toHaveClass("text-yellow-400");
    expect(screen.getByText("src")).toHaveClass("text-yellow-400");
    // 根目录本身（长度 <= rootPath）不冒泡
    expect(screen.getByText("README.md")).not.toHaveClass("text-yellow-400");
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
    expect(screen.getByText("src")).toHaveClass("text-yellow-400");
    expect(screen.getByText("other.ts")).toHaveClass("text-emerald-400");
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
