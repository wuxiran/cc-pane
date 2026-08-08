import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useActivityBarStore,
  useEditorTabsStore,
  useSshMachinesStore,
  useSshRemoteFilePreferencesStore,
  useSshRemoteFilesStore,
} from "@/stores";
import type { SshMachine } from "@/types";
import SshRemoteFilesView from "./SshRemoteFilesView";

const serviceMocks = vi.hoisted(() => ({
  configurePassword: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  readImage: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  createDirectory: vi.fn(),
  renameEntry: vi.fn(),
  deleteEntry: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  setPermissions: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services")>(),
  sshFileService: serviceMocks,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const machine: SshMachine = {
  id: "m-1",
  name: "production",
  host: "server.example.com",
  port: 22,
  user: "dev",
  authMethod: "password",
  defaultPath: "/srv/app",
  tags: [],
  hasStoredPassword: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderView() {
  return render(
    <TooltipProvider>
      <SshRemoteFilesView />
    </TooltipProvider>,
  );
}

describe("SshRemoteFilesView", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("zh-CN");
    useSshRemoteFilesStore.setState({
      sessionPasswordMachineIds: [],
      directoryCache: {},
    });
    useEditorTabsStore.setState({ tabs: [], activeTabId: null, recentFiles: [] });
    useActivityBarStore.setState({
      appViewMode: "panes",
      activeView: "ssh",
      sidebarVisible: true,
    });
    useSshRemoteFilePreferencesStore.setState({
      viewMode: "tree",
      sortKey: "name",
      sortDirection: "asc",
      bookmarks: {},
    });
    useSshMachinesStore.setState({ machines: [machine] });
    useSshRemoteFilesStore.getState().openMachine(machine.id, machine.defaultPath);
    serviceMocks.listDirectory.mockImplementation(async (_machineId: string, path: string) => ({
      path,
      entries: path === "/srv/app"
        ? [{
            name: "src",
            path: "/srv/app/src",
            isDir: true,
            isFile: false,
            isSymlink: false,
            size: 0,
            modified: null,
            extension: null,
            hidden: false,
          }, {
            name: "README.md",
            path: "/srv/app/README.md",
            isDir: false,
            isFile: true,
            isSymlink: false,
            size: 5,
            modified: "2026-01-02T03:04:00Z",
            extension: "md",
            hidden: false,
          }]
        : [],
    }));
    serviceMocks.configurePassword.mockResolvedValue(undefined);
    serviceMocks.readFile.mockResolvedValue({
      path: "/srv/app/README.md",
      content: "hello",
      encoding: "utf-8",
      size: 5,
      language: "markdown",
    });
    serviceMocks.writeFile.mockResolvedValue(undefined);
  });

  it("does not navigate when a tree folder is double-clicked", async () => {
    const user = userEvent.setup();
    renderView();

    await user.dblClick(await screen.findByText("src"));

    expect(useSshRemoteFilesStore.getState().currentPath).toBe("/srv/app");
  });

  it("does not navigate when a list folder is double-clicked", async () => {
    const user = userEvent.setup();
    useSshRemoteFilePreferencesStore.setState({ viewMode: "list" });
    renderView();

    await user.dblClick(await screen.findByText("src"));

    expect(useSshRemoteFilesStore.getState().currentPath).toBe("/srv/app");
  });

  it("shows terminal actions only for remote folders", async () => {
    renderView();

    fireEvent.contextMenu(await screen.findByText("src"));

    expect(await screen.findByText(/CD to this directory|CD 到此目录/)).toBeVisible();
    expect(screen.getByText(/Open terminal here|在此目录打开终端/)).toBeVisible();
  });

  it("does not show terminal actions for remote files", async () => {
    renderView();

    fireEvent.contextMenu(await screen.findByText("README.md"));
    expect(await screen.findByText(/Open file|打开文件/)).toBeVisible();

    expect(screen.queryByText(/CD to this directory|CD 到此目录/)).toBeNull();
    expect(screen.queryByText(/Open terminal here|在此目录打开终端/)).toBeNull();
  });

  it("prompts for a missing password and uses it without saving", async () => {
    const user = userEvent.setup();
    let credentialReady = false;
    useSshMachinesStore.setState({
      machines: [{ ...machine, hasStoredPassword: false }],
    });
    serviceMocks.listDirectory.mockImplementation(async (_machineId: string, path: string) => {
      if (!credentialReady) throw new Error("No saved password for SSH machine");
      return { path, entries: [] };
    });
    serviceMocks.configurePassword.mockImplementation(async () => {
      credentialReady = true;
    });

    renderView();

    const password = await screen.findByLabelText(/SSH password|SSH 密码/);
    expect(serviceMocks.listDirectory).toHaveBeenCalledWith("m-1", "/srv/app", true);
    await user.type(password, "temporary-secret");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Connect|连接/ }));

    await waitFor(() => expect(serviceMocks.configurePassword).toHaveBeenCalledWith(
      "m-1",
      "temporary-secret",
      false,
    ));
    await waitFor(() => expect(serviceMocks.listDirectory).toHaveBeenCalledWith(
      "m-1",
      "/srv/app",
      true,
    ));
    await waitFor(() => expect(screen.queryByLabelText(/SSH password|SSH 密码/)).toBeNull());
  });

  it("reuses a backend session password after frontend session state resets", async () => {
    useSshMachinesStore.setState({
      machines: [{ ...machine, hasStoredPassword: false }],
    });
    useSshRemoteFilesStore.setState({ sessionPasswordMachineIds: [] });

    renderView();

    expect(await screen.findByText("README.md")).toBeVisible();
    expect(serviceMocks.listDirectory).toHaveBeenCalledWith("m-1", "/srv/app", true);
    expect(screen.queryByLabelText(/SSH password|SSH 密码/)).toBeNull();
  });

  it("opens a clicked remote file without replacing the SSH sidebar", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByText("README.md"));

    const state = useEditorTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      title: "README.md",
      filePath: "/srv/app/README.md",
      ssh: { machineId: "m-1", machineName: "production", size: 5 },
    });
    expect(useActivityBarStore.getState()).toMatchObject({
      appViewMode: "files",
      activeView: "ssh",
      sidebarVisible: true,
    });
    expect(serviceMocks.readFile).not.toHaveBeenCalled();
  });

  it("reuses cached directory content after the panel remounts", async () => {
    const first = renderView();
    expect(await screen.findByText("README.md")).toBeVisible();
    first.unmount();

    renderView();
    expect(await screen.findByText("README.md")).toBeVisible();
    expect(serviceMocks.listDirectory).toHaveBeenCalledTimes(1);
  });

  it("reuses cached tree children after the panel remounts", async () => {
    const user = userEvent.setup();
    const first = renderView();
    await user.click(await screen.findByText("src"));
    await waitFor(() => expect(
      useSshRemoteFilesStore.getState().getCachedDirectory("m-1", "/srv/app/src", true),
    ).toBeDefined());
    first.unmount();

    renderView();
    await user.click(await screen.findByText("src"));
    const childLoads = serviceMocks.listDirectory.mock.calls.filter((call) => (
      call[1] === "/srv/app/src"
    ));
    expect(childLoads).toHaveLength(1);
  });

  it("bypasses cached directory content when refresh is clicked", async () => {
    const user = userEvent.setup();
    renderView();
    expect(await screen.findByText("README.md")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Refresh|刷新/ }));
    await waitFor(() => expect(serviceMocks.listDirectory).toHaveBeenCalledTimes(2));
  });

  it("shows Xterminal-style detail columns without the removed toolbar actions", async () => {
    useSshRemoteFilePreferencesStore.setState({ viewMode: "list" });
    renderView();

    expect(await screen.findByRole("columnheader", { name: /Name|名称/ })).toBeVisible();
    expect(screen.getByText(/Permissions|权限/)).toBeVisible();
    expect(screen.getByText(/Modified|修改时间/)).toBeVisible();
    expect(screen.getByText("README.md")).toBeVisible();
    expect(screen.getByText("src")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Filter files|筛选文件/ })).toBeNull();
    expect(screen.queryByLabelText(/Remote path|远程路径/)).toBeNull();
  });

  it("formats modified dates with the selected app language", async () => {
    useSshRemoteFilePreferencesStore.setState({ viewMode: "list" });
    const value = "2026-01-02T03:04:00Z";
    const options: Intl.DateTimeFormatOptions = {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    };
    const chinese = new Intl.DateTimeFormat("zh-CN", options).format(new Date(value));
    const english = new Intl.DateTimeFormat("en-US", options).format(new Date(value));
    renderView();

    expect(await screen.findByText(chinese)).toBeVisible();

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(await screen.findByText(english)).toBeVisible();
  });

  it("keeps the machine selector and requested navigation controls visible", async () => {
    renderView();

    const machineSelector = await screen.findByRole("combobox", { name: /SSH machine|SSH 机器/ });
    expect(machineSelector).toHaveAttribute("data-slot", "select-trigger");
    expect(machineSelector).toHaveTextContent("production");
    expect(screen.getByRole("button", { name: /Back|后退/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Home directory|主目录/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Show hidden|显示隐藏文件|Hide hidden|不显示隐藏文件/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Refresh|刷新/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Collapse All|全部折叠/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /List view|列表视图|Tree view/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Forward|前进|Up|上一级|Search|筛选文件/ })).toBeNull();
  });

  it("returns to the remote filesystem root from the home button", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("README.md");

    await user.click(screen.getByRole("button", { name: /Home directory|主目录/ }));

    await waitFor(() => expect(useSshRemoteFilesStore.getState().currentPath).toBe("/"));
    await waitFor(() => expect(serviceMocks.listDirectory).toHaveBeenCalledWith("m-1", "/", true));
  });

  it("collapses a tree directory when loading its children fails", async () => {
    const user = userEvent.setup();
    serviceMocks.listDirectory.mockImplementation(async (_machineId: string, path: string) => {
      if (path === "/srv/app/src") throw new Error("SFTP directory unavailable");
      return {
        path,
        entries: [{
          name: "src",
          path: "/srv/app/src",
          isDir: true,
          isFile: false,
          isSymlink: false,
          size: 0,
          modified: null,
          extension: null,
          hidden: false,
        }],
      };
    });

    renderView();
    const src = await screen.findByText("src");
    const treeItem = src.closest("[role='treeitem']");
    expect(treeItem).not.toBeNull();
    await user.click(treeItem!);

    await waitFor(() => expect(serviceMocks.listDirectory).toHaveBeenCalledWith(
      "m-1",
      "/srv/app/src",
      true,
    ));
    await waitFor(() => expect(treeItem).toHaveAttribute("aria-expanded", "false"));
  });

  it("matches the Files tab tree-first hierarchy and row styling", async () => {
    renderView();

    const root = await screen.findByRole("treeitem", { name: "app" });
    expect(root).toHaveAttribute("aria-expanded", "true");

    const src = screen.getByText("src");
    expect(src).toHaveClass("font-semibold");
    expect(src.closest("[role='treeitem']")).toHaveClass("rounded-md");
    expect(screen.queryByRole("columnheader")).toBeNull();
  });
});
