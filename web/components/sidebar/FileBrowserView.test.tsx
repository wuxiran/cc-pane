import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileBrowserStore, useWorkspacesStore } from "@/stores";
import { useFileTreeStore } from "@/stores/useFileTreeStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import FileBrowserView from "./FileBrowserView";

const tt = (k: string) => String(i18n.t(k as never));

function renderView() {
  return render(
    <TooltipProvider>
      <FileBrowserView />
    </TooltipProvider>,
  );
}

const getAppCwd = vi.fn(async () => "D:/app/cwd");
const getDataDirInfo = vi.fn(async () => ({ currentPath: "D:/data/dir" }));

vi.mock("@/services", () => ({
  selfChatService: { getAppCwd: () => getAppCwd() },
  settingsService: { getDataDirInfo: () => getDataDirInfo() },
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "D:/home/user"),
}));

import { homeDir } from "@tauri-apps/api/path";
const mockHomeDir = homeDir as ReturnType<typeof vi.fn>;

vi.mock("@/components/filetree", () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => (
    <div data-testid="file-tree">{rootPath}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const refresh = vi.fn(async () => undefined);
const loadGitStatuses = vi.fn(async () => undefined);
const collapseAll = vi.fn();
const clearTree = vi.fn();
const revealFile = vi.fn(async () => undefined);
const createFile = vi.fn(async () => undefined);
const createDirectory = vi.fn(async () => undefined);

function resetFileBrowser(currentPath: string, historyIndex = 0) {
  useFileBrowserStore.setState({
    currentPath,
    history: currentPath ? [currentPath] : [],
    historyIndex: currentPath ? historyIndex : -1,
    refreshKey: 0,
  });
}

describe("FileBrowserView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppCwd.mockResolvedValue("D:/app/cwd");
    mockHomeDir.mockResolvedValue("D:/home/user");
    useWorkspacesStore.setState({ workspaces: [] });
    resetFileBrowser("");
    useFileTreeStore.setState({
      selectedFilePath: null,
      refresh,
      loadGitStatuses,
      collapseAll,
      clearTree,
      revealFile,
      createFile,
      createDirectory,
    });
  });

  it("renders the Files header", () => {
    renderView();
    expect(screen.getByText(/^Files$|^文件$/)).toBeVisible();
  });

  it("shows the empty placeholder when no path is selected and cwd is unavailable", async () => {
    getAppCwd.mockRejectedValue(new Error("no cwd"));
    mockHomeDir.mockResolvedValue(null);
    renderView();

    expect(await screen.findByText(/Select a directory to browse|选择一个目录/i)).toBeVisible();
    expect(screen.queryByTestId("file-tree")).not.toBeInTheDocument();
  });

  it("initializes the path from the app cwd on mount", async () => {
    renderView();

    await waitFor(() => expect(getAppCwd).toHaveBeenCalled());
    expect(await screen.findByTestId("file-tree")).toHaveTextContent("D:/app/cwd");
  });

  it("renders the FileTree with the current path when one is set", () => {
    resetFileBrowser("D:/projects/app");
    renderView();

    expect(screen.getByTestId("file-tree")).toHaveTextContent("D:/projects/app");
  });

  it("does not render toolbar buttons when there is no path", () => {
    renderView();
    // Only children of header; no toolbar action buttons render without a path
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("refreshes the file tree and git statuses when clicking refresh", () => {
    resetFileBrowser("D:/projects/app");
    renderView();

    // Toolbar order: back, forward, up, home, newFile, newFolder, refresh, collapseAll, reveal
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[6]);

    expect(refresh).toHaveBeenCalledWith("D:/projects/app");
    expect(loadGitStatuses).toHaveBeenCalledWith("D:/projects/app");
  });

  it("collapses the tree when clicking collapse all", () => {
    resetFileBrowser("D:/projects/app");
    renderView();

    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[7]);

    expect(collapseAll).toHaveBeenCalledWith("D:/projects/app");
  });

  it("opens the New File dialog and creates a file", async () => {
    resetFileBrowser("D:/projects/app");
    renderView();

    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[4]); // New File

    expect(await screen.findByText(tt("sidebar:filetree.dialogNewFile"))).toBeVisible();
    const input = screen.getByPlaceholderText("filename.ext");
    fireEvent.change(input, { target: { value: "index.ts" } });
    fireEvent.click(screen.getByRole("button", { name: tt("common:create") }));

    await waitFor(() =>
      expect(createFile).toHaveBeenCalledWith("D:/projects/app", "index.ts", "D:/projects/app"),
    );
  });

  it("opens the New Folder dialog and creates a directory", async () => {
    resetFileBrowser("D:/projects/app");
    renderView();

    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[5]); // New Folder

    expect(await screen.findByText(tt("sidebar:filetree.dialogNewFolder"))).toBeVisible();
    const input = screen.getByPlaceholderText("folder-name");
    fireEvent.change(input, { target: { value: "components" } });
    fireEvent.click(screen.getByRole("button", { name: tt("common:create") }));

    await waitFor(() =>
      expect(createDirectory).toHaveBeenCalledWith("D:/projects/app", "components", "D:/projects/app"),
    );
  });

  it("disables the back button when there is no back history", () => {
    resetFileBrowser("D:/projects/app", 0);
    renderView();

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toBeDisabled(); // back
    expect(buttons[1]).toBeDisabled(); // forward
  });
});
