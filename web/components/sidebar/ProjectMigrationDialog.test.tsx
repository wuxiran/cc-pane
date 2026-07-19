import i18n from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectMigrationDialog from "./ProjectMigrationDialog";
import { createTestWorkspace, createTestWorkspaceProject, resetTestDataCounter } from "@/test/utils/testData";
import { useWorkspacesStore } from "@/stores";
import type { ProjectMigrationPlan, ProjectMigrationResult, Workspace, WorkspaceProject, WslDistro } from "@/types";

const tt = (k: string, opts?: Record<string, unknown>) =>
  String(i18n.t(k as never, opts as never));
const tRe = (k: string, opts?: Record<string, unknown>) => new RegExp(tt(k, opts));

const previewProjectMigration = vi.fn();
const executeProjectMigration = vi.fn();
const rollbackProjectMigration = vi.fn();
const discoverWslDistros = vi.fn<() => Promise<WslDistro[]>>(async () => []);

vi.mock("@/services/workspaceService", () => ({
  previewProjectMigration: (...args: unknown[]) => previewProjectMigration(...args),
  executeProjectMigration: (...args: unknown[]) => executeProjectMigration(...args),
  rollbackProjectMigration: (...args: unknown[]) => rollbackProjectMigration(...args),
}));

vi.mock("@/services/sshMachineService", () => ({
  discoverWslDistros: () => discoverWslDistros(),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
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

function makePlan(overrides: Partial<ProjectMigrationPlan> = {}): ProjectMigrationPlan {
  return {
    workspaceName: "workspace-alpha",
    projectId: "proj-1",
    projectName: "api",
    sourcePath: "D:/workspace/api",
    destinationPath: "/home/dev/api",
    targetKind: "wsl",
    targetRoot: "/home/dev/api",
    targetDistro: "Ubuntu",
    warnings: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<ProjectMigrationResult> = {}): ProjectMigrationResult {
  return {
    status: "succeeded",
    snapshotId: "snap-123",
    workspace: createTestWorkspace(),
    plan: makePlan(),
    copiedFiles: 42,
    copiedBytes: 2048,
    warnings: [],
    ...overrides,
  };
}

function renderDialog(opts: {
  open?: boolean;
  workspace?: Workspace | null;
  project?: WorkspaceProject | null;
} = {}) {
  const workspace =
    opts.workspace === undefined
      ? createTestWorkspace({ name: "workspace-alpha", path: "D:/workspace" })
      : opts.workspace;
  const project =
    opts.project === undefined
      ? createTestWorkspaceProject({ id: "proj-1", alias: "api", path: "D:/workspace/api" })
      : opts.project;
  const onOpenChange = vi.fn();
  render(
    <ProjectMigrationDialog
      open={opts.open ?? true}
      onOpenChange={onOpenChange}
      workspace={workspace}
      project={project}
    />,
  );
  return { onOpenChange, workspace, project };
}

describe("ProjectMigrationDialog", () => {
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

  it("workspace 或 project 为空时不渲染主体内容", () => {
    renderDialog({ workspace: null, project: null });
    expect(screen.getByText(tt("dialogs:projectMigration.title"))).toBeVisible();
    expect(screen.queryByText(tt("dialogs:projectMigration.preview"))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: tt("dialogs:projectMigration.preview") })).not.toBeInTheDocument();
  });

  it("渲染源项目信息与工作空间信息", () => {
    renderDialog();
    expect(screen.getByText("api")).toBeVisible();
    expect(screen.getByText(tt("dialogs:projectMigration.workspace", { name: "workspace-alpha" }))).toBeVisible();
    expect(screen.getByText(tt("dialogs:projectMigration.source", { path: "D:/workspace/api" }))).toBeVisible();
  });

  it("非 Windows 平台显示提示并禁用 Preview/Execute", () => {
    setPlatform("MacIntel");
    renderDialog();
    expect(screen.getByText(tt("dialogs:projectMigration.windowsOnly"))).toBeVisible();
    expect(screen.getByRole("button", { name: tt("dialogs:projectMigration.preview") })).toBeDisabled();
    expect(screen.getByRole("button", { name: tt("dialogs:projectMigration.execute") })).toBeDisabled();
  });

  it("打开时按项目路径推导默认 WSL 目标路径", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("/home/dev/project-name")).toHaveValue("/mnt/d/workspace/api");
    });
  });

  it("打开时在 Windows 下加载 WSL 发行版列表", async () => {
    discoverWslDistros.mockResolvedValue([
      {
        name: "Ubuntu",
        state: "running" as const,
        wslVersion: 2,
        isDefault: true,
        defaultUser: "dev",
        alreadyImported: false,
      },
    ]);
    renderDialog();
    await waitFor(() => expect(discoverWslDistros).toHaveBeenCalled());
    expect(
      await screen.findByRole("option", {
        name: new RegExp("Ubuntu" + tt("dialogs:projectMigration.defaultSuffix")),
      }),
    ).toBeInTheDocument();
  });

  it("Preview 成功后渲染预览计划与警告", async () => {
    const user = userEvent.setup();
    previewProjectMigration.mockResolvedValue(
      makePlan({ warnings: ["target already exists"] }),
    );
    renderDialog();

    await user.click(screen.getByRole("button", { name: tt("dialogs:projectMigration.preview") }));

    await waitFor(() => expect(previewProjectMigration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(tt("dialogs:projectMigration.project", { name: "api" }))).toBeVisible();
    expect(screen.getByText(tt("dialogs:projectMigration.targetRoot", { path: "/home/dev/api" }))).toBeVisible();
    expect(screen.getByText("target already exists")).toBeVisible();
    // 预览后 Execute 可用
    expect(screen.getByRole("button", { name: tt("dialogs:projectMigration.execute") })).toBeEnabled();
  });

  it("Preview 失败时提示错误且不出现预览", async () => {
    const user = userEvent.setup();
    previewProjectMigration.mockRejectedValue(new Error("preview boom"));
    renderDialog();

    await user.click(screen.getByRole("button", { name: tt("dialogs:projectMigration.preview") }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("preview boom"));
    expect(screen.queryByText(tt("dialogs:projectMigration.project", { name: "api" }))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: tt("dialogs:projectMigration.execute") })).toBeDisabled();
  });

  it("Execute 成功后展示结果、刷新工作空间并出现回滚按钮", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => {});
    useWorkspacesStore.setState({ load });
    previewProjectMigration.mockResolvedValue(makePlan());
    executeProjectMigration.mockResolvedValue(makeResult({ copiedFiles: 7, snapshotId: "snap-xyz" }));
    renderDialog();

    await user.click(screen.getByRole("button", { name: tt("dialogs:projectMigration.preview") }));
    await screen.findByText(tt("dialogs:projectMigration.project", { name: "api" }));
    await user.click(screen.getByRole("button", { name: tt("dialogs:projectMigration.execute") }));

    await waitFor(() => expect(executeProjectMigration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已复制 7 个文件/)).toBeVisible();
    expect(screen.getByText(tt("dialogs:projectMigration.snapshot", { id: "snap-xyz" }))).toBeVisible();
    expect(load).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: tRe("dialogs:projectMigration.rollbackMetadata") })).toBeVisible();
  });

  it("Execute 后点击回滚调用 rollback 并清除结果", async () => {
    const user = userEvent.setup();
    previewProjectMigration.mockResolvedValue(makePlan());
    executeProjectMigration.mockResolvedValue(makeResult({ snapshotId: "snap-roll" }));
    rollbackProjectMigration.mockResolvedValue({ snapshotId: "snap-roll", workspace: createTestWorkspace() });
    renderDialog();

    await user.click(screen.getByRole("button", { name: tt("dialogs:projectMigration.preview") }));
    await screen.findByText(tt("dialogs:projectMigration.project", { name: "api" }));
    await user.click(screen.getByRole("button", { name: tt("dialogs:projectMigration.execute") }));
    await screen.findByRole("button", { name: tRe("dialogs:projectMigration.rollbackMetadata") });

    await user.click(screen.getByRole("button", { name: tRe("dialogs:projectMigration.rollbackMetadata") }));

    await waitFor(() =>
      expect(rollbackProjectMigration).toHaveBeenCalledWith("workspace-alpha", "snap-roll"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: tRe("dialogs:projectMigration.rollbackMetadata") })).not.toBeInTheDocument(),
    );
  });

  it("Close 按钮触发 onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    // Radix 自带右上角关闭按钮带 data-slot="dialog-close"，这里选择底部页脚 Close 按钮
    const footerClose = screen
      .getAllByRole("button", { name: tt("common:close") })
      .find((btn) => btn.getAttribute("data-slot") !== "dialog-close");
    await user.click(footerClose!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
