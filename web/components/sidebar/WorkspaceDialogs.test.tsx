import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceDialogs, { ConfirmDialog } from "./WorkspaceDialogs";
import type { WorkspaceDialogsProps } from "./WorkspaceDialogs";

// 用轻量占位替换重型子对话框，隔离 WorkspaceDialogs 自身逻辑
vi.mock("@/components/ScanImportDialog", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="scan-dialog" /> : null),
}));
vi.mock("@/components/GitCloneDialog", () => ({
  default: ({ open, workspaceName }: { open: boolean; workspaceName: string }) =>
    open ? <div data-testid="git-clone-dialog">{workspaceName}</div> : null,
}));
vi.mock("./ProjectMigrationDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="project-migration-dialog" /> : null,
}));

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

function makeProps(overrides: DeepPartial<WorkspaceDialogsProps> = {}): {
  props: WorkspaceDialogsProps;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies = {
    newSetOpen: vi.fn(),
    newSetName: vi.fn(),
    newSetPath: vi.fn(),
    newSelectPath: vi.fn(),
    newConfirm: vi.fn(),
    renameSetOpen: vi.fn(),
    renameSetName: vi.fn(),
    renameConfirm: vi.fn(),
    projectAliasSetOpen: vi.fn(),
    projectAliasSetValue: vi.fn(),
    projectAliasConfirm: vi.fn(),
    workspaceAliasSetOpen: vi.fn(),
    workspaceAliasSetValue: vi.fn(),
    workspaceAliasConfirm: vi.fn(),
    scanSetOpen: vi.fn(),
    scanConfirm: vi.fn(),
    gitCloneSetOpen: vi.fn(),
    gitCloned: vi.fn(),
    migrationSetOpen: vi.fn(),
    confirmSetOpen: vi.fn(),
    confirmConfirm: vi.fn(),
  };

  const base: WorkspaceDialogsProps = {
    newWorkspace: {
      open: false,
      setOpen: spies.newSetOpen,
      name: "",
      setName: spies.newSetName,
      path: "",
      setPath: spies.newSetPath,
      group: "",
      setGroup: vi.fn(),
      onSelectPath: spies.newSelectPath,
      onConfirm: spies.newConfirm,
    },
    renameWorkspace: {
      open: false,
      setOpen: spies.renameSetOpen,
      name: "",
      setName: spies.renameSetName,
      onConfirm: spies.renameConfirm,
    },
    projectAlias: {
      open: false,
      setOpen: spies.projectAliasSetOpen,
      value: "",
      setValue: spies.projectAliasSetValue,
      onConfirm: spies.projectAliasConfirm,
    },
    workspaceAlias: {
      open: false,
      setOpen: spies.workspaceAliasSetOpen,
      value: "",
      setValue: spies.workspaceAliasSetValue,
      onConfirm: spies.workspaceAliasConfirm,
    },
    scan: {
      open: false,
      setOpen: spies.scanSetOpen,
      results: [],
      onConfirm: spies.scanConfirm,
    },
    gitClone: {
      open: false,
      setOpen: spies.gitCloneSetOpen,
      workspaceName: "workspace-alpha",
      onCloned: spies.gitCloned,
    },
    projectMigration: {
      open: false,
      setOpen: spies.migrationSetOpen,
      workspace: null,
      project: null,
    },
    confirm: {
      open: false,
      setOpen: spies.confirmSetOpen,
      title: "确认操作",
      description: "此操作会影响项目",
      onConfirm: spies.confirmConfirm,
    },
  };

  // 浅合并每个分组
  const props = { ...base } as WorkspaceDialogsProps;
  for (const key of Object.keys(overrides) as (keyof WorkspaceDialogsProps)[]) {
    props[key] = { ...(base[key] as object), ...(overrides[key] as object) } as never;
  }

  return { props, spies };
}

describe("WorkspaceDialogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("所有对话框关闭时不渲染任何对话框内容", () => {
    const { props } = makeProps();
    render(<WorkspaceDialogs {...props} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scan-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-clone-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-migration-dialog")).not.toBeInTheDocument();
  });

  it("新建工作空间：名称为空时创建按钮禁用", () => {
    const { props } = makeProps({ newWorkspace: { open: true, name: "" } });
    render(<WorkspaceDialogs {...props} />);

    const createBtn = screen.getByRole("button", { name: /创建|Create/i });
    expect(createBtn).toBeDisabled();
  });

  it("新建工作空间：填写名称后创建按钮启用并可确认", async () => {
    const user = userEvent.setup();
    const { props, spies } = makeProps({
      newWorkspace: { open: true, name: "my-workspace" },
    });
    render(<WorkspaceDialogs {...props} />);

    const createBtn = screen.getByRole("button", { name: /创建|Create/i });
    expect(createBtn).toBeEnabled();
    await user.click(createBtn);
    expect(spies.newConfirm).toHaveBeenCalledTimes(1);
  });

  it("新建工作空间：输入名称触发 setName，点击 Browse 触发 onSelectPath", async () => {
    const user = userEvent.setup();
    const { props, spies } = makeProps({ newWorkspace: { open: true, name: "" } });
    render(<WorkspaceDialogs {...props} />);

    const nameInput = screen.getByPlaceholderText(/工作空间名称|Workspace name/i);
    await user.type(nameInput, "a");
    expect(spies.newSetName).toHaveBeenCalledWith("a");

    await user.click(screen.getByRole("button", { name: /Browse/i }));
    expect(spies.newSelectPath).toHaveBeenCalledTimes(1);
  });

  it("新建工作空间：取消按钮调用 setOpen(false)", async () => {
    const user = userEvent.setup();
    const { props, spies } = makeProps({
      newWorkspace: { open: true, name: "x" },
    });
    render(<WorkspaceDialogs {...props} />);

    await user.click(screen.getByRole("button", { name: /取消|Cancel/i }));
    expect(spies.newSetOpen).toHaveBeenCalledWith(false);
  });

  it("重命名工作空间：回车触发 onConfirm", async () => {
    const { props, spies } = makeProps({
      renameWorkspace: { open: true, name: "old-name" },
    });
    render(<WorkspaceDialogs {...props} />);

    expect(screen.getByText(/重命名工作空间|Rename Workspace/i)).toBeVisible();
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spies.renameConfirm).toHaveBeenCalledTimes(1);
  });

  it("项目别名对话框：输入触发 setValue", async () => {
    const user = userEvent.setup();
    const { props, spies } = makeProps({
      projectAlias: { open: true, value: "" },
    });
    render(<WorkspaceDialogs {...props} />);

    expect(screen.getByText(/设置项目别名|Set Project Alias/i)).toBeVisible();
    await user.type(screen.getByRole("textbox"), "z");
    expect(spies.projectAliasSetValue).toHaveBeenCalledWith("z");
  });

  it("工作空间别名对话框：确认按钮触发 onConfirm", async () => {
    const user = userEvent.setup();
    const { props, spies } = makeProps({
      workspaceAlias: { open: true, value: "alias" },
    });
    render(<WorkspaceDialogs {...props} />);

    expect(screen.getByText(/设置工作空间别名|Set Workspace Alias/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /确定|OK/i }));
    expect(spies.workspaceAliasConfirm).toHaveBeenCalledTimes(1);
  });

  it("扫描导入对话框打开时渲染占位子组件", () => {
    const { props } = makeProps({ scan: { open: true } });
    render(<WorkspaceDialogs {...props} />);
    expect(screen.getByTestId("scan-dialog")).toBeInTheDocument();
  });

  it("Git Clone 对话框打开时透传 workspaceName", () => {
    const { props } = makeProps({ gitClone: { open: true, workspaceName: "repo-ws" } });
    render(<WorkspaceDialogs {...props} />);
    expect(screen.getByTestId("git-clone-dialog")).toHaveTextContent("repo-ws");
  });

  it("项目迁移对话框打开时渲染占位子组件", () => {
    const { props } = makeProps({ projectMigration: { open: true } });
    render(<WorkspaceDialogs {...props} />);
    expect(screen.getByTestId("project-migration-dialog")).toBeInTheDocument();
  });

  it("确认对话框：渲染标题描述，确认/取消调用对应回调", async () => {
    const user = userEvent.setup();
    const { props, spies } = makeProps({
      confirm: { open: true, title: "删除工作空间", description: "无法恢复" },
    });
    render(<WorkspaceDialogs {...props} />);

    expect(screen.getByText("删除工作空间")).toBeVisible();
    expect(screen.getByText("无法恢复")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /确定|OK/i }));
    expect(spies.confirmConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /取消|Cancel/i }));
    expect(spies.confirmSetOpen).toHaveBeenCalledWith(false);
  });
});

describe("ConfirmDialog", () => {
  it("destructive 变体使用危险按钮样式类", () => {
    render(
      <ConfirmDialog
        open
        setOpen={vi.fn()}
        title="危险操作"
        description="确认删除"
        onConfirm={vi.fn()}
        variant="destructive"
      />,
    );

    const confirmBtn = screen.getByRole("button", { name: /确定|OK/i });
    // destructive variant 会带上危险背景色 class
    expect(confirmBtn.className).toMatch(/bg-destructive/);
  });

  it("默认变体不使用危险按钮样式类", () => {
    render(
      <ConfirmDialog
        open
        setOpen={vi.fn()}
        title="普通操作"
        description="确认"
        onConfirm={vi.fn()}
      />,
    );

    const confirmBtn = screen.getByRole("button", { name: /确定|OK/i });
    expect(confirmBtn.className).not.toMatch(/bg-destructive/);
    expect(confirmBtn.className).toMatch(/bg-primary/);
  });
});
