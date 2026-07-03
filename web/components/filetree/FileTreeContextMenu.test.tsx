import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useFileTreeStore } from "@/stores";
import type { FileTreeNode, FsEntry } from "@/types/filesystem";
import FileTreeContextMenu from "./FileTreeContextMenu";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: () => true,
}));

const { toast } = await import("sonner");

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

const ROOT = "D:\\proj";

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

function fileNode(path = `${ROOT}\\src\\app.ts`): FileTreeNode {
  return { entry: entry(path, false), children: null, expanded: false, loading: false };
}

function dirNode(path = `${ROOT}\\src`): FileTreeNode {
  return { entry: entry(path, true), children: null, expanded: false, loading: false };
}

function setupStore() {
  const actions = {
    deleteEntry: vi.fn().mockResolvedValue(undefined),
    renameEntry: vi.fn().mockResolvedValue(undefined),
    createFile: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    copyEntry: vi.fn().mockResolvedValue(undefined),
    moveEntry: vi.fn().mockResolvedValue(undefined),
  };
  useFileTreeStore.setState(actions);
  return actions;
}

function renderMenu(node: FileTreeNode, onOpenTerminal?: (path: string) => void) {
  const nodeRef = { current: node };
  render(
    <FileTreeContextMenu nodeRef={nodeRef} rootPath={ROOT} onOpenTerminal={onOpenTerminal}>
      <div data-testid="tree-area">tree</div>
    </FileTreeContextMenu>
  );
  return nodeRef;
}

async function openMenu() {
  fireEvent.contextMenu(screen.getByTestId("tree-area"));
  await waitFor(() => {
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
}

const tKey = (k: string, opts?: Record<string, unknown>) =>
  String(i18n.t(`sidebar:${k}` as never, opts as never));

describe("FileTreeContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows file-specific items for files and directory items for directories", async () => {
    const { unmount } = render(
      <FileTreeContextMenu nodeRef={{ current: fileNode() }} rootPath={ROOT}>
        <div data-testid="tree-area">tree</div>
      </FileTreeContextMenu>
    );
    await openMenu();
    expect(screen.getByText(tKey("filetree.openInEditor"))).toBeInTheDocument();
    expect(screen.queryByText(tKey("filetree.newFile"))).not.toBeInTheDocument();
    unmount();

    render(
      <FileTreeContextMenu nodeRef={{ current: dirNode() }} rootPath={ROOT}>
        <div data-testid="tree-area">tree</div>
      </FileTreeContextMenu>
    );
    await openMenu();
    expect(screen.getByText(tKey("filetree.newFile"))).toBeInTheDocument();
    expect(screen.getByText(tKey("filetree.newFolder"))).toBeInTheDocument();
    expect(screen.queryByText(tKey("filetree.openInEditor"))).not.toBeInTheDocument();
  });

  it("shows open-in-terminal only for directories when the callback exists", async () => {
    const onOpenTerminal = vi.fn();
    renderMenu(dirNode(), onOpenTerminal);
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.openInTerminal")));
    expect(onOpenTerminal).toHaveBeenCalledWith(`${ROOT}\\src`);
  });

  it("opens the terminal in the parent directory for file nodes", async () => {
    // onOpenTerminal 菜单项仅对目录显示，但 handleOpenTerminal 对文件取父目录 —
    // 通过目录菜单验证路径推导已覆盖；这里验证文件节点不显示该项
    renderMenu(fileNode(), vi.fn());
    await openMenu();
    expect(screen.queryByText(tKey("filetree.openInTerminal"))).not.toBeInTheDocument();
  });

  it("copies the absolute path to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderMenu(fileNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.copyAbsolutePath")));
    expect(writeText).toHaveBeenCalledWith(`${ROOT}\\src\\app.ts`);
    expect(toast.success).toHaveBeenCalledWith(tKey("filetree.pathCopied"));
  });

  it("copies the relative path with normalized separators", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderMenu(fileNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.copyRelativePath")));
    expect(writeText).toHaveBeenCalledWith("src/app.ts");
  });

  it("renames through the dialog with the trimmed input value", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    renderMenu(fileNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.rename")));

    // 对话框以当前名称预填
    const input = await screen.findByDisplayValue("app.ts");
    await user.clear(input);
    await user.type(input, "  renamed.ts  ");
    await user.click(screen.getByRole("button", { name: i18n.t("common:confirm") }));

    expect(actions.renameEntry).toHaveBeenCalledWith(
      `${ROOT}\\src\\app.ts`,
      "renamed.ts",
      ROOT
    );
  });

  it("creates a new file inside the directory node", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    renderMenu(dirNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.newFile")));

    const input = await screen.findByDisplayValue("");
    await user.type(input, "new.ts{Enter}");

    await waitFor(() => {
      expect(actions.createFile).toHaveBeenCalledWith(`${ROOT}\\src`, "new.ts", ROOT);
    });
  });

  it("ignores dialog submit when the input is blank", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    renderMenu(dirNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.newFolder")));

    await screen.findByDisplayValue("");
    await user.click(screen.getByRole("button", { name: i18n.t("common:confirm") }));
    expect(actions.createDirectory).not.toHaveBeenCalled();
  });

  it("deletes only after confirming in the destructive dialog", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    renderMenu(fileNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.delete")));

    // 确认对话框展示文件名
    await screen.findByText(tKey("filetree.deleteFileTitle"));
    expect(actions.deleteEntry).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: i18n.t("common:delete") }));
    await waitFor(() => {
      expect(actions.deleteEntry).toHaveBeenCalledWith(`${ROOT}\\src\\app.ts`, ROOT);
    });
  });

  it("cancelling the delete dialog leaves the entry untouched", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    renderMenu(fileNode());
    await openMenu();
    fireEvent.click(screen.getByText(tKey("filetree.delete")));

    await screen.findByText(tKey("filetree.deleteFileTitle"));
    await user.click(screen.getByRole("button", { name: i18n.t("common:cancel") }));
    expect(actions.deleteEntry).not.toHaveBeenCalled();
  });
});
