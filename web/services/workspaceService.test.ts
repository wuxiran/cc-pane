import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  renameWorkspace,
  deleteWorkspace,
  addWorkspaceProject,
  removeWorkspaceProject,
  updateWorkspaceAlias,
  updateWorkspaceProjectAlias,
  updateWorkspaceProvider,
  updateWorkspacePinned,
  updateWorkspaceHidden,
  reorderWorkspaces,
  gitClone,
  scanDirectory,
} from "./workspaceService";
import type { GitCloneRequest } from "./workspaceService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
  resetTestDataCounter,
} from "@/test/utils/testData";

describe("workspaceService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  describe("listWorkspaces", () => {
    it("应该调用 list_workspaces 命令并返回工作空间列表", async () => {
      const workspaces = [createTestWorkspace(), createTestWorkspace()];
      mockTauriInvoke({ list_workspaces: workspaces });

      const result = await listWorkspaces();

      expect(invoke).toHaveBeenCalledWith("list_workspaces");
      expect(result).toEqual(workspaces);
    });

    it("应该在空列表时返回空数组", async () => {
      mockTauriInvoke({ list_workspaces: [] });

      const result = await listWorkspaces();

      expect(result).toEqual([]);
    });
  });

  describe("createWorkspace", () => {
    it("应该调用 create_workspace 命令并返回新工作空间", async () => {
      const workspace = createTestWorkspace({ name: "ws-1" });
      mockTauriInvoke({ create_workspace: workspace });

      const result = await createWorkspace("ws-1", "/test/path");

      expect(invoke).toHaveBeenCalledWith("create_workspace", { name: "ws-1", path: "/test/path" });
      expect(result).toEqual(workspace);
    });
  });

  describe("getWorkspace", () => {
    it("应该调用 get_workspace 命令并返回工作空间", async () => {
      const workspace = createTestWorkspace({ name: "ws-1" });
      mockTauriInvoke({ get_workspace: workspace });

      const result = await getWorkspace("ws-1");

      expect(invoke).toHaveBeenCalledWith("get_workspace", { name: "ws-1" });
      expect(result).toEqual(workspace);
    });
  });

  describe("renameWorkspace", () => {
    it("应该调用 rename_workspace 命令", async () => {
      mockTauriInvoke({ rename_workspace: undefined });

      await renameWorkspace("old", "new");

      expect(invoke).toHaveBeenCalledWith("rename_workspace", {
        oldName: "old",
        newName: "new",
      });
    });
  });

  describe("deleteWorkspace", () => {
    it("应该调用 delete_workspace 命令", async () => {
      mockTauriInvoke({ delete_workspace: undefined });

      await deleteWorkspace("ws-1");

      expect(invoke).toHaveBeenCalledWith("delete_workspace", { name: "ws-1" });
    });
  });

  describe("addWorkspaceProject", () => {
    it("应该调用 add_workspace_project 命令并返回工作空间项目", async () => {
      const project = createTestWorkspaceProject();
      mockTauriInvoke({ add_workspace_project: project });

      const result = await addWorkspaceProject("ws-1", "/path/to/project");

      expect(invoke).toHaveBeenCalledWith("add_workspace_project", {
        workspaceName: "ws-1",
        path: "/path/to/project",
      });
      expect(result).toEqual(project);
    });
  });

  describe("removeWorkspaceProject", () => {
    it("应该调用 remove_workspace_project 命令", async () => {
      mockTauriInvoke({ remove_workspace_project: undefined });

      await removeWorkspaceProject("ws-1", "p-1");

      expect(invoke).toHaveBeenCalledWith("remove_workspace_project", {
        workspaceName: "ws-1",
        projectId: "p-1",
      });
    });
  });

  describe("updateWorkspaceAlias", () => {
    it("应该调用 update_workspace_alias 命令", async () => {
      mockTauriInvoke({ update_workspace_alias: undefined });

      await updateWorkspaceAlias("ws-1", "alias");

      expect(invoke).toHaveBeenCalledWith("update_workspace_alias", {
        workspaceName: "ws-1",
        alias: "alias",
      });
    });

    it("应该支持设置 null 别名", async () => {
      mockTauriInvoke({ update_workspace_alias: undefined });

      await updateWorkspaceAlias("ws-1", null);

      expect(invoke).toHaveBeenCalledWith("update_workspace_alias", {
        workspaceName: "ws-1",
        alias: null,
      });
    });
  });

  describe("updateWorkspaceProjectAlias", () => {
    it("应该调用 update_workspace_project_alias 命令", async () => {
      mockTauriInvoke({ update_workspace_project_alias: undefined });

      await updateWorkspaceProjectAlias("ws-1", "p-1", "alias");

      expect(invoke).toHaveBeenCalledWith("update_workspace_project_alias", {
        workspaceName: "ws-1",
        projectId: "p-1",
        alias: "alias",
      });
    });

    it("应该支持设置 null 别名", async () => {
      mockTauriInvoke({ update_workspace_project_alias: undefined });

      await updateWorkspaceProjectAlias("ws-1", "p-1", null);

      expect(invoke).toHaveBeenCalledWith("update_workspace_project_alias", {
        workspaceName: "ws-1",
        projectId: "p-1",
        alias: null,
      });
    });
  });

  describe("updateWorkspaceProvider", () => {
    it("应该调用 update_workspace_provider 命令", async () => {
      mockTauriInvoke({ update_workspace_provider: undefined });

      await updateWorkspaceProvider("ws-1", "prov-1");

      expect(invoke).toHaveBeenCalledWith("update_workspace_provider", {
        workspaceName: "ws-1",
        providerId: "prov-1",
      });
    });

    it("应该支持设置 null provider", async () => {
      mockTauriInvoke({ update_workspace_provider: undefined });

      await updateWorkspaceProvider("ws-1", null);

      expect(invoke).toHaveBeenCalledWith("update_workspace_provider", {
        workspaceName: "ws-1",
        providerId: null,
      });
    });
  });

  describe("updateWorkspacePinned", () => {
    it("应该先获取工作空间再调用 update_workspace 命令", async () => {
      const workspace = createTestWorkspace({ name: "ws-1" });
      mockTauriInvoke({
        get_workspace: workspace,
        update_workspace: undefined,
      });

      await updateWorkspacePinned("ws-1", true);

      expect(invoke).toHaveBeenCalledWith("get_workspace", { name: "ws-1" });
      expect(invoke).toHaveBeenCalledWith("update_workspace", {
        name: "ws-1",
        workspace: { ...workspace, pinned: true },
      });
    });
  });

  describe("updateWorkspaceHidden", () => {
    it("应该先获取工作空间再调用 update_workspace 命令", async () => {
      const workspace = createTestWorkspace({ name: "ws-1" });
      mockTauriInvoke({
        get_workspace: workspace,
        update_workspace: undefined,
      });

      await updateWorkspaceHidden("ws-1", true);

      expect(invoke).toHaveBeenCalledWith("get_workspace", { name: "ws-1" });
      expect(invoke).toHaveBeenCalledWith("update_workspace", {
        name: "ws-1",
        workspace: { ...workspace, hidden: true },
      });
    });
  });

  describe("reorderWorkspaces", () => {
    it("应该调用 reorder_workspaces 命令", async () => {
      mockTauriInvoke({ reorder_workspaces: undefined });

      await reorderWorkspaces(["ws-1", "ws-2"]);

      expect(invoke).toHaveBeenCalledWith("reorder_workspaces", {
        orderedNames: ["ws-1", "ws-2"],
      });
    });
  });

  describe("gitClone", () => {
    it("应该调用 git_clone 命令并返回克隆路径", async () => {
      const request: GitCloneRequest = {
        url: "https://github.com/user/repo.git",
        targetDir: "/tmp/clone",
        folderName: "repo",
        shallow: true,
      };
      mockTauriInvoke({ git_clone: "/tmp/clone/repo" });

      const result = await gitClone(request);

      expect(invoke).toHaveBeenCalledWith("git_clone", { request });
      expect(result).toBe("/tmp/clone/repo");
    });
  });

  describe("scanDirectory", () => {
    it("应该调用 scan_workspace_directory 命令并返回扫描结果", async () => {
      const scannedRepos = [
        {
          mainPath: "/root/repo1",
          mainBranch: "main",
          worktrees: [{ path: "/root/repo1-wt", branch: "feature" }],
        },
      ];
      mockTauriInvoke({ scan_workspace_directory: scannedRepos });

      const result = await scanDirectory("/root");

      expect(invoke).toHaveBeenCalledWith("scan_workspace_directory", {
        rootPath: "/root",
      });
      expect(result).toEqual(scannedRepos);
    });
  });
});
