import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceMigrationDialog from "./WorkspaceMigrationDialog";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import { useWorkspacesStore } from "@/stores";
import type { Workspace, WorkspaceMigrationPlan, WorkspaceMigrationResult } from "@/types";

const previewWorkspaceMigration = vi.fn();
const executeWorkspaceMigration = vi.fn();
const rollbackWorkspaceMigration = vi.fn();
const discoverWslDistros = vi.fn(async () => []);
const openDialog = vi.fn();

vi.mock("@/services/workspaceService", () => ({
  previewWorkspaceMigration: (...args: unknown[]) => previewWorkspaceMigration(...args),
  executeWorkspaceMigration: (...args: unknown[]) => executeWorkspaceMigration(...args),
  rollbackWorkspaceMigration: (...args: unknown[]) => rollbackWorkspaceMigration(...args),
}));

vi.mock("@/services/sshMachineService", () => ({
  discoverWslDistros: () => discoverWslDistros(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialog(...args),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

function makePlan(overrides: Partial<WorkspaceMigrationPlan> = {}): WorkspaceMigrationPlan {
  return {
    workspaceName: "workspace-alpha",
    sourceRoot: "D:/workspace",
    rootDestination: "/home/dev/workspace",
    targetKind: "wsl",
    targetRoot: "/home/dev/workspace",
    targetDistro: "Ubuntu",
    items: [],
    warnings: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<WorkspaceMigrationResult> = {}): WorkspaceMigrationResult {
  return {
    status: "succeeded",
    snapshotId: "snap-1",
    workspace: createTestWorkspace(),
    plan: makePlan(),
    copiedFiles: 10,
    copiedBytes: 4096,
    warnings: [],
    ...overrides,
  };
}

function renderDialog(opts: { open?: boolean; workspace?: Workspace | null } = {}) {
  const workspace =
    opts.workspace === undefined
      ? createTestWorkspace({ name: "workspace-alpha", path: "D:/workspace" })
      : opts.workspace;
  const onOpenChange = vi.fn();
  render(
    <WorkspaceMigrationDialog
      open={opts.open ?? true}
      onOpenChange={onOpenChange}
      workspace={workspace}
    />,
  );
  return { onOpenChange, workspace };
}

describe("WorkspaceMigrationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    discoverWslDistros.mockResolvedValue([]);
    useWorkspacesStore.setState({ load: vi.fn(async () => {}) });
    setPlatform("Win32");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("workspace 为空时不渲染主体信息", () => {
    renderDialog({ workspace: null });
    expect(screen.getByText("迁移工作空间")).toBeVisible();
    expect(screen.queryByText("源目录：")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "先预检" })).not.toBeInTheDocument();
  });

  it("渲染工作空间名与源目录", () => {
    renderDialog();
    expect(screen.getByText("workspace-alpha")).toBeVisible();
    expect(screen.getByText(/源目录：D:\/workspace/)).toBeVisible();
  });

  it("Windows 下默认目标环境为 WSL 并展示 WSL 选项", async () => {
    renderDialog();
    // WSL 目标根目录 label 只在 targetKind === wsl 出现
    expect(await screen.findByText("WSL 目标根目录")).toBeVisible();
    await waitFor(() => expect(discoverWslDistros).toHaveBeenCalled());
  });

  it("非 Windows 平台默认目标为本机并隐藏 WSL 按钮", () => {
    setPlatform("MacIntel");
    renderDialog();
    expect(screen.getByText("目标目录")).toBeVisible();
    expect(screen.queryByRole("button", { name: "WSL" })).not.toBeInTheDocument();
    expect(discoverWslDistros).not.toHaveBeenCalled();
  });

  it("切换到本机目标后显示目标目录输入并可通过对话框选择", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue("D:/copy-target");
    renderDialog();

    await user.click(screen.getByRole("button", { name: "本机" }));
    expect(await screen.findByText("目标目录")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "选择" }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText("D:/workspace-wsl-copy")).toHaveValue("D:/copy-target"),
    );
  });

  it("Preview 成功后渲染迁移预览、项目条目与警告", async () => {
    const user = userEvent.setup();
    previewWorkspaceMigration.mockResolvedValue(
      makePlan({
        items: [
          {
            projectId: "p1",
            projectName: "api",
            sourcePath: "D:/workspace/api",
            destinationPath: "/home/dev/workspace/api",
            external: true,
          },
        ],
        warnings: ["some warning"],
      }),
    );
    renderDialog();

    await user.click(screen.getByRole("button", { name: "先预检" }));

    expect(await screen.findByText("迁移预览")).toBeVisible();
    expect(screen.getByText("api")).toBeVisible();
    expect(screen.getByText("external")).toBeVisible();
    expect(screen.getByText("some warning")).toBeVisible();
    expect(screen.getByRole("button", { name: "执行迁移" })).toBeEnabled();
  });

  it("预览没有可迁移项目时显示空态提示", async () => {
    const user = userEvent.setup();
    previewWorkspaceMigration.mockResolvedValue(makePlan({ items: [] }));
    renderDialog();

    await user.click(screen.getByRole("button", { name: "先预检" }));
    expect(await screen.findByText(/当前没有可迁移的本地项目/)).toBeVisible();
  });

  it("Preview 失败时提示错误且执行按钮保持禁用", async () => {
    const user = userEvent.setup();
    previewWorkspaceMigration.mockRejectedValue("preview failed");
    renderDialog();

    await user.click(screen.getByRole("button", { name: "先预检" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("preview failed"));
    expect(screen.queryByText("迁移预览")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行迁移" })).toBeDisabled();
  });

  it("Execute 成功后展示结果、刷新工作空间并出现回滚按钮", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => {});
    useWorkspacesStore.setState({ load });
    previewWorkspaceMigration.mockResolvedValue(makePlan());
    executeWorkspaceMigration.mockResolvedValue(makeResult({ copiedFiles: 5, snapshotId: "snap-e" }));
    renderDialog();

    await user.click(screen.getByRole("button", { name: "先预检" }));
    await screen.findByText("迁移预览");
    await user.click(screen.getByRole("button", { name: "执行迁移" }));

    expect(await screen.findByText(/已完成切换/)).toBeVisible();
    expect(screen.getByText(/快照 ID：snap-e/)).toBeVisible();
    expect(load).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "回滚配置" })).toBeVisible();
  });

  it("Execute 后点击回滚调用 rollback 并清除结果", async () => {
    const user = userEvent.setup();
    previewWorkspaceMigration.mockResolvedValue(makePlan());
    executeWorkspaceMigration.mockResolvedValue(makeResult({ snapshotId: "snap-r" }));
    rollbackWorkspaceMigration.mockResolvedValue({ snapshotId: "snap-r", workspace: createTestWorkspace() });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "先预检" }));
    await screen.findByText("迁移预览");
    await user.click(screen.getByRole("button", { name: "执行迁移" }));
    await screen.findByRole("button", { name: "回滚配置" });

    await user.click(screen.getByRole("button", { name: "回滚配置" }));

    await waitFor(() =>
      expect(rollbackWorkspaceMigration).toHaveBeenCalledWith("workspace-alpha", "snap-r"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "回滚配置" })).not.toBeInTheDocument(),
    );
  });

  it("关闭按钮触发 onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    const footerClose = screen
      .getAllByRole("button", { name: "关闭" })
      .find((btn) => btn.getAttribute("data-slot") !== "dialog-close");
    await user.click(footerClose!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
