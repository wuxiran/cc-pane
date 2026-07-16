import "@/i18n";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useWorkspaceActions } from "./useWorkspaceActions";
import { useWorkspacesStore, usePanesStore, useDialogStore } from "@/stores";
import { worktreeService } from "@/services";
import { invokeOrApi } from "@/services/apiClient";
import { scanDirectory } from "@/services/workspaceService";
import type { Workspace, WorkspaceProject } from "@/types";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invokeOrApi: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("@/services/worktreeService", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  worktreeService: {
    isGitRepo: vi.fn(),
    list: vi.fn(),
  },
}));

vi.mock("@/services/workspaceService", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanDirectory: vi.fn(),
}));

function makeProject(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return { id: "proj-1", path: "D:/repos/alpha", ...overrides };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "主工作区",
    createdAt: "2026-01-01",
    path: "D:/workspaces/main",
    projects: [makeProject()],
    ...overrides,
  };
}

const storeActions = {
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  updateProjectAlias: vi.fn(),
  updateWorkspaceAlias: vi.fn(),
};

const paneActions = {
  openMcpConfig: vi.fn(),
  openSkillManager: vi.fn(),
  openMemoryManager: vi.fn(),
};

const openTodo = vi.fn();
const onOpenTerminal = vi.fn();

function setup() {
  return renderHook(() => useWorkspaceActions({ onOpenTerminal }));
}

describe("useWorkspaceActions", () => {
  beforeEach(() => {
    for (const fn of Object.values(storeActions)) fn.mockReset().mockResolvedValue(undefined);
    for (const fn of Object.values(paneActions)) fn.mockReset();
    openTodo.mockReset();
    onOpenTerminal.mockReset();
    vi.mocked(toast.info).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(open).mockReset();
    vi.mocked(invokeOrApi).mockReset().mockResolvedValue(null);
    vi.mocked(worktreeService.isGitRepo).mockReset().mockResolvedValue(false);
    vi.mocked(worktreeService.list).mockReset().mockResolvedValue([]);
    vi.mocked(scanDirectory).mockReset().mockResolvedValue([]);

    useWorkspacesStore.setState({
      ...storeActions,
      workspaces: [],
      expandedWorkspaceId: null,
    });
    usePanesStore.setState({ ...paneActions });
    useDialogStore.setState({ openTodo });
  });

  describe("工作空间创建", () => {
    it("handleCreateWorkspace 打开对话框并清空输入", () => {
      const { result } = setup();
      act(() => {
        result.current.dialogs.newWorkspace.setName("残留");
        result.current.dialogs.newWorkspace.setPath("D:/old");
      });
      act(() => result.current.handleCreateWorkspace());

      expect(result.current.dialogs.newWorkspace.open).toBe(true);
      expect(result.current.dialogs.newWorkspace.name).toBe("");
      expect(result.current.dialogs.newWorkspace.path).toBe("");
    });

    it("确认创建：trim 名称、空路径传 undefined、成功后关闭", async () => {
      const { result } = setup();
      act(() => {
        result.current.handleCreateWorkspace();
        result.current.dialogs.newWorkspace.setName("  新空间  ");
        result.current.dialogs.newWorkspace.setPath("   ");
      });
      await act(async () => {
        await result.current.dialogs.newWorkspace.onConfirm();
      });

      expect(storeActions.create).toHaveBeenCalledWith("新空间", undefined);
      expect(result.current.dialogs.newWorkspace.open).toBe(false);
    });

    it("名称为空白时不创建", async () => {
      const { result } = setup();
      act(() => {
        result.current.handleCreateWorkspace();
        result.current.dialogs.newWorkspace.setName("   ");
      });
      await act(async () => {
        await result.current.dialogs.newWorkspace.onConfirm();
      });
      expect(storeActions.create).not.toHaveBeenCalled();
    });

    it("创建失败时 toast 报错且对话框保持打开", async () => {
      storeActions.create.mockRejectedValue(new Error("duplicate"));
      const { result } = setup();
      act(() => {
        result.current.handleCreateWorkspace();
        result.current.dialogs.newWorkspace.setName("重复");
      });
      await act(async () => {
        await result.current.dialogs.newWorkspace.onConfirm();
      });

      expect(toast.error).toHaveBeenCalled();
      expect(result.current.dialogs.newWorkspace.open).toBe(true);
    });

    it("选择路径：系统目录对话框返回路径后写入", async () => {
      vi.mocked(open).mockResolvedValue("D:/picked");
      const { result } = setup();
      await act(async () => {
        await result.current.dialogs.newWorkspace.onSelectPath();
      });
      expect(result.current.dialogs.newWorkspace.path).toBe("D:/picked");
    });
  });

  describe("工作空间重命名 / 删除 / 别名", () => {
    it("重命名流程：预填旧名，确认时 trim 并关闭", async () => {
      const ws = makeWorkspace({ name: "旧名" });
      const { result } = setup();
      act(() => result.current.handleRenameWorkspace(ws));
      expect(result.current.dialogs.renameWorkspace.open).toBe(true);
      expect(result.current.dialogs.renameWorkspace.name).toBe("旧名");

      act(() => result.current.dialogs.renameWorkspace.setName(" 新名 "));
      await act(async () => {
        await result.current.dialogs.renameWorkspace.onConfirm();
      });

      expect(storeActions.rename).toHaveBeenCalledWith("旧名", "新名");
      expect(result.current.dialogs.renameWorkspace.open).toBe(false);
    });

    it("删除工作空间走 destructive 确认，确认后执行删除", async () => {
      const ws = makeWorkspace();
      const { result } = setup();
      act(() => result.current.handleDeleteWorkspace(ws));

      expect(result.current.dialogs.confirm.open).toBe(true);
      expect(result.current.dialogs.confirm.variant).toBe("destructive");
      expect(storeActions.remove).not.toHaveBeenCalled();

      await act(async () => {
        result.current.dialogs.confirm.onConfirm();
      });
      expect(result.current.dialogs.confirm.open).toBe(false);
      await waitFor(() => expect(storeActions.remove).toHaveBeenCalledWith(ws.name));
    });

    it("工作空间别名：确认时 trim，空白转 null", async () => {
      const ws = makeWorkspace({ alias: "旧别名" });
      const { result } = setup();
      act(() => result.current.handleSetWorkspaceAlias(ws));
      expect(result.current.dialogs.workspaceAlias.value).toBe("旧别名");

      act(() => result.current.dialogs.workspaceAlias.setValue("   "));
      await act(async () => {
        await result.current.dialogs.workspaceAlias.onConfirm();
      });

      expect(storeActions.updateWorkspaceAlias).toHaveBeenCalledWith(ws.name, null);
      expect(result.current.dialogs.workspaceAlias.open).toBe(false);
    });
  });

  describe("项目操作", () => {
    it("导入项目：目录对话框选中后加入工作空间", async () => {
      vi.mocked(open).mockResolvedValue("D:/repos/beta");
      const ws = makeWorkspace();
      const { result } = setup();
      await act(async () => {
        await result.current.handleImportProject(ws);
      });
      expect(storeActions.addProject).toHaveBeenCalledWith(ws.name, "D:/repos/beta");
    });

    it("导入项目：取消选择时不加项目", async () => {
      vi.mocked(open).mockResolvedValue(null);
      const { result } = setup();
      await act(async () => {
        await result.current.handleImportProject(makeWorkspace());
      });
      expect(storeActions.addProject).not.toHaveBeenCalled();
    });

    it("移除项目走确认流程，确认后按项目 id 删除", async () => {
      const ws = makeWorkspace();
      const project = makeProject({ id: "proj-9", alias: "别名项目" });
      const { result } = setup();
      act(() => result.current.handleRemoveProject(ws, project));
      expect(result.current.dialogs.confirm.variant).toBe("destructive");

      await act(async () => {
        result.current.dialogs.confirm.onConfirm();
      });
      await waitFor(() =>
        expect(storeActions.removeProject).toHaveBeenCalledWith(ws.name, "proj-9")
      );
    });

    it("项目别名：预填现值，确认更新并关闭", async () => {
      const ws = makeWorkspace();
      const project = makeProject({ alias: "旧别名" });
      const { result } = setup();
      act(() => result.current.handleSetAlias(ws, project));
      expect(result.current.dialogs.projectAlias.value).toBe("旧别名");

      act(() => result.current.dialogs.projectAlias.setValue(" alpha-2 "));
      await act(async () => {
        await result.current.dialogs.projectAlias.onConfirm();
      });

      expect(storeActions.updateProjectAlias).toHaveBeenCalledWith(ws.name, project.id, "alpha-2");
      expect(result.current.dialogs.projectAlias.open).toBe(false);
    });
  });

  describe("扫描导入 / Git Clone", () => {
    it("扫描无 Git 仓库时提示且不开结果对话框", async () => {
      vi.mocked(open).mockResolvedValue("D:/scan-root");
      vi.mocked(scanDirectory).mockResolvedValue([]);
      const { result } = setup();
      await act(async () => {
        await result.current.handleScanImport(makeWorkspace());
      });

      expect(toast.info).toHaveBeenCalled();
      expect(result.current.dialogs.scan.open).toBe(false);
    });

    it("扫描到仓库时打开结果对话框，确认后逐个导入并统计跳过", async () => {
      vi.mocked(open).mockResolvedValue("D:/scan-root");
      const repos = [
        { path: "D:/scan-root/a", name: "a" },
        { path: "D:/scan-root/b", name: "b" },
      ];
      vi.mocked(scanDirectory).mockResolvedValue(repos as never);
      const ws = makeWorkspace();
      const { result } = setup();
      await act(async () => {
        await result.current.handleScanImport(ws);
      });
      expect(result.current.dialogs.scan.open).toBe(true);
      expect(result.current.dialogs.scan.results).toEqual(repos);

      storeActions.addProject
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("duplicate"));
      await act(async () => {
        await result.current.dialogs.scan.onConfirm(["D:/scan-root/a", "D:/scan-root/b"]);
      });

      expect(storeActions.addProject).toHaveBeenCalledTimes(2);
      // skipped > 0 时提示导入结果
      expect(toast.info).toHaveBeenCalledTimes(1);
    });

    it("全部导入成功时不弹统计提示", async () => {
      vi.mocked(open).mockResolvedValue("D:/scan-root");
      vi.mocked(scanDirectory).mockResolvedValue([{ path: "D:/scan-root/a", name: "a" }] as never);
      const { result } = setup();
      await act(async () => {
        await result.current.handleScanImport(makeWorkspace());
      });
      await act(async () => {
        await result.current.dialogs.scan.onConfirm(["D:/scan-root/a"]);
      });
      expect(toast.info).not.toHaveBeenCalled();
    });

    it("扫描失败时 toast 报错", async () => {
      vi.mocked(open).mockResolvedValue("D:/scan-root");
      vi.mocked(scanDirectory).mockRejectedValue(new Error("io error"));
      const { result } = setup();
      await act(async () => {
        await result.current.handleScanImport(makeWorkspace());
      });
      expect(toast.error).toHaveBeenCalled();
    });

    it("git clone 完成后把克隆路径加入目标工作空间", async () => {
      const ws = makeWorkspace({ name: "克隆目标" });
      const { result } = setup();
      act(() => result.current.handleGitClone(ws));
      expect(result.current.dialogs.gitClone.open).toBe(true);
      expect(result.current.dialogs.gitClone.workspaceName).toBe("克隆目标");

      await act(async () => {
        await result.current.dialogs.gitClone.onCloned("D:/repos/cloned");
      });
      expect(storeActions.addProject).toHaveBeenCalledWith("克隆目标", "D:/repos/cloned");
    });
  });

  describe("打开终端与面板", () => {
    it("打开工作空间使用第一个项目路径；空工作空间不打开", () => {
      const ws = makeWorkspace();
      const { result } = setup();
      act(() => result.current.handleOpenWorkspace(ws));
      expect(onOpenTerminal).toHaveBeenCalledWith({
        path: "D:/repos/alpha",
        workspaceName: ws.name,
        workspacePath: ws.path,
      });

      onOpenTerminal.mockClear();
      act(() => result.current.handleOpenWorkspace(makeWorkspace({ projects: [] })));
      expect(onOpenTerminal).not.toHaveBeenCalled();
    });

    it("打开项目 / worktree 透传路径与工作空间信息", () => {
      const ws = makeWorkspace();
      const project = makeProject({ path: "D:/repos/beta" });
      const { result } = setup();

      act(() => result.current.handleOpenProject(project, ws));
      expect(onOpenTerminal).toHaveBeenCalledWith({
        path: "D:/repos/beta",
        workspaceName: ws.name,
        workspacePath: ws.path,
      });

      act(() => result.current.handleOpenWorktree("D:/repos/beta-wt"));
      expect(onOpenTerminal).toHaveBeenCalledWith({ path: "D:/repos/beta-wt" });
    });

    it("MCP/Skill/Memory 管理器用别名（缺省回退目录名）打开", () => {
      const { result } = setup();
      act(() => result.current.handleOpenMcpConfig(makeProject({ alias: "别名" })));
      expect(paneActions.openMcpConfig).toHaveBeenCalledWith("D:/repos/alpha", "别名");

      act(() => result.current.handleOpenSkillManager(makeProject({ alias: undefined })));
      expect(paneActions.openSkillManager).toHaveBeenCalledWith("D:/repos/alpha", "alpha");

      act(() => result.current.handleOpenMemoryManager(makeProject({ alias: "记忆" })));
      expect(paneActions.openMemoryManager).toHaveBeenCalledWith("D:/repos/alpha", "记忆");
    });

    it("Todo 管理器缺省 scope 为 global", () => {
      const { result } = setup();
      act(() => result.current.handleOpenTodoManager());
      expect(openTodo).toHaveBeenCalledWith("global", "");

      act(() => result.current.handleOpenTodoManager("project", "D:/repos/alpha"));
      expect(openTodo).toHaveBeenCalledWith("project", "D:/repos/alpha");
    });
  });

  describe("Git 分支与 Worktree 缓存", () => {
    it("展开工作空间时为每个项目拉取分支和 worktree", async () => {
      const ws = makeWorkspace({
        projects: [
          makeProject({ id: "p1", path: "D:/repos/alpha" }),
          makeProject({ id: "p2", path: "D:/repos/beta" }),
        ],
      });
      useWorkspacesStore.setState({ workspaces: [ws], expandedWorkspaceId: ws.id });
      vi.mocked(invokeOrApi).mockResolvedValue("main");
      vi.mocked(worktreeService.isGitRepo).mockResolvedValue(true);
      vi.mocked(worktreeService.list).mockResolvedValue([
        { path: "D:/repos/alpha-wt", branch: "feat" },
      ] as never);

      const { result } = setup();

      await waitFor(() => {
        expect(result.current.gitBranches).toEqual({
          "D:/repos/alpha": "main",
          "D:/repos/beta": "main",
        });
      });
      await waitFor(() => {
        expect(result.current.worktreeCache["D:/repos/alpha"]).toEqual([
          { path: "D:/repos/alpha-wt", branch: "feat" },
        ]);
      });
      expect(invokeOrApi).toHaveBeenCalledWith(
        "get_git_branch",
        { path: "D:/repos/alpha" },
        expect.any(Function),
      );
    });

    it("非 git 项目 worktree 缓存为空数组，分支查询失败记为 null", async () => {
      const ws = makeWorkspace({ projects: [makeProject({ path: "D:/repos/plain" })] });
      useWorkspacesStore.setState({ workspaces: [ws], expandedWorkspaceId: ws.id });
      vi.mocked(invokeOrApi).mockRejectedValue(new Error("not a repo"));
      vi.mocked(worktreeService.isGitRepo).mockResolvedValue(false);

      const { result } = setup();

      await waitFor(() => {
        expect(result.current.gitBranches).toEqual({ "D:/repos/plain": null });
        expect(result.current.worktreeCache).toEqual({ "D:/repos/plain": [] });
      });
      expect(worktreeService.list).not.toHaveBeenCalled();
    });

    it("路径为空白的项目被跳过，未展开工作空间时不拉取", async () => {
      const ws = makeWorkspace({ projects: [makeProject({ path: "   " })] });
      useWorkspacesStore.setState({ workspaces: [ws], expandedWorkspaceId: null });
      setup();
      await act(async () => {});
      expect(invokeOrApi).not.toHaveBeenCalled();

      act(() => {
        useWorkspacesStore.setState({ expandedWorkspaceId: ws.id });
      });
      await act(async () => {});
      expect(invokeOrApi).not.toHaveBeenCalled();
      expect(worktreeService.isGitRepo).not.toHaveBeenCalled();
    });
  });
});
