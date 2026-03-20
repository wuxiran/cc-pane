import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useWorkspacesStore, usePanesStore, useDialogStore } from "@/stores";
import { worktreeService, type WorktreeInfo } from "@/services";
import { scanDirectory, type ScannedRepo } from "@/services/workspaceService";
import { getProjectName } from "@/utils";
import type { Workspace, WorkspaceProject, OpenTerminalOptions } from "@/types";

interface UseWorkspaceActionsParams {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export function useWorkspaceActions({ onOpenTerminal }: UseWorkspaceActionsParams) {
  const { t: tSidebar } = useTranslation("sidebar");
  const { t: tNotify } = useTranslation("notifications");

  const createWorkspace = useWorkspacesStore((s) => s.create);
  const renameWs = useWorkspacesStore((s) => s.rename);
  const removeWorkspace = useWorkspacesStore((s) => s.remove);
  const addProject = useWorkspacesStore((s) => s.addProject);
  const removeProject = useWorkspacesStore((s) => s.removeProject);
  const updateProjectAlias = useWorkspacesStore((s) => s.updateProjectAlias);
  const updateWorkspaceAlias = useWorkspacesStore((s) => s.updateWorkspaceAlias);
  const updateWorkspaceProvider = useWorkspacesStore((s) => s.updateWorkspaceProvider);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);

  // Git 分支 & Worktree 缓存
  const [gitBranches, setGitBranches] = useState<Record<string, string | null>>({});
  const [worktreeCache, setWorktreeCache] = useState<Record<string, WorktreeInfo[]>>({});

  // Dialog 状态
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = useState(false);
  const [renameWorkspaceOldName, setRenameWorkspaceOldName] = useState("");
  const [renameWorkspaceNewName, setRenameWorkspaceNewName] = useState("");
  const [aliasDialogOpen, setAliasDialogOpen] = useState(false);
  const [aliasWorkspaceName, setAliasWorkspaceName] = useState("");
  const [aliasProjectId, setAliasProjectId] = useState("");
  const [aliasValue, setAliasValue] = useState("");
  const [wsAliasDialogOpen, setWsAliasDialogOpen] = useState(false);
  const [wsAliasTargetName, setWsAliasTargetName] = useState("");
  const [wsAliasValue, setWsAliasValue] = useState("");
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [scanResults, setScanResults] = useState<ScannedRepo[]>([]);
  const [scanTargetWorkspace, setScanTargetWorkspace] = useState<Workspace | null>(null);
  const [gitCloneOpen, setGitCloneOpen] = useState(false);
  const [gitCloneTargetWorkspace, setGitCloneTargetWorkspace] = useState<string>("");

  // 确认对话框状态
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDescription, setConfirmDescription] = useState("");
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(null);
  const [confirmVariant, setConfirmVariant] = useState<"default" | "destructive">("default");

  const showConfirm = useCallback(
    (title: string, description: string, onConfirm: () => void, variant: "default" | "destructive" = "default") => {
      setConfirmTitle(title);
      setConfirmDescription(description);
      // 用函数包装，避免 React 将 onConfirm 当作 state updater
      setConfirmCallback(() => onConfirm);
      setConfirmVariant(variant);
      setConfirmOpen(true);
    },
    []
  );

  const handleConfirm = useCallback(() => {
    setConfirmOpen(false);
    confirmCallback?.();
  }, [confirmCallback]);

  // Git 分支
  const fetchGitBranch = useCallback(async (path: string): Promise<string | null> => {
    try {
      return await invoke<string | null>("get_git_branch", { path });
    } catch {
      return null;
    }
  }, []);

  // Worktree 列表
  const fetchWorktrees = useCallback(async (path: string) => {
    try {
      const isGit = await worktreeService.isGitRepo(path);
      if (isGit) {
        const wts = await worktreeService.list(path);
        setWorktreeCache((prev) => ({ ...prev, [path]: wts }));
      } else {
        setWorktreeCache((prev) => ({ ...prev, [path]: [] }));
      }
    } catch {
      setWorktreeCache((prev) => ({ ...prev, [path]: [] }));
    }
  }, []);

  useEffect(() => {
    if (!expandedWorkspaceId) return;
    const currentWorkspaces = useWorkspacesStore.getState().workspaces;
    const ws = currentWorkspaces.find((w) => w.id === expandedWorkspaceId);
    if (!ws) return;
    for (const project of ws.projects) {
      setGitBranches((prev) => {
        if (project.path in prev) return prev;
        fetchGitBranch(project.path).then((branch) => {
          setGitBranches((p) => ({ ...p, [project.path]: branch }));
        });
        return prev;
      });
      setWorktreeCache((prev) => {
        if (project.path in prev) return prev;
        fetchWorktrees(project.path);
        return prev;
      });
    }
  }, [expandedWorkspaceId, fetchGitBranch, fetchWorktrees]);

  // ============ 工作空间操作 ============

  function handleCreateWorkspace() {
    setNewWorkspaceName("");
    setNewWorkspacePath("");
    setNewWorkspaceOpen(true);
  }

  async function handleSelectNewWorkspacePath() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择工作空间根目录" });
      if (selected) {
        setNewWorkspacePath(selected);
      }
    } catch (e) {
      toast.error(tNotify("createFailed", { error: String(e) }));
    }
  }

  async function confirmCreateWorkspace() {
    if (!newWorkspaceName.trim() || !newWorkspacePath.trim()) return;
    try {
      await createWorkspace(newWorkspaceName.trim(), newWorkspacePath.trim());
      setNewWorkspaceOpen(false);
    } catch (e) {
      toast.error(tNotify("createFailed", { error: String(e) }));
    }
  }

  function handleRenameWorkspace(ws: Workspace) {
    setRenameWorkspaceOldName(ws.name);
    setRenameWorkspaceNewName(ws.name);
    setRenameWorkspaceOpen(true);
  }

  async function confirmRenameWorkspace() {
    if (!renameWorkspaceNewName.trim()) return;
    try {
      await renameWs(renameWorkspaceOldName, renameWorkspaceNewName.trim());
      setRenameWorkspaceOpen(false);
    } catch (e) {
      toast.error(tNotify("renameFailed", { error: String(e) }));
    }
  }

  function handleDeleteWorkspace(ws: Workspace) {
    showConfirm(
      tSidebar("deleteWorkspaceTitle"),
      tSidebar("deleteWorkspaceConfirm", { name: ws.name }),
      async () => {
        try {
          await removeWorkspace(ws.name);
        } catch (e) {
          toast.error(tNotify("operationFailed", { error: String(e) }));
        }
      },
      "destructive"
    );
  }

  // ============ 项目操作 ============

  async function handleImportProject(ws: Workspace) {
    try {
      const selected = await open({ directory: true, multiple: false, title: tSidebar("selectProjectDir") });
      if (selected) {
        await addProject(ws.name, selected);
      }
    } catch (e) {
      toast.error(tNotify("importFailed", { error: String(e) }));
    }
  }

  function handleRemoveProject(ws: Workspace, project: WorkspaceProject) {
    const displayName = project.alias || getProjectName(project.path);
    showConfirm(
      tSidebar("removeProjectTitle"),
      tSidebar("removeProjectConfirm", { name: displayName }),
      async () => {
        try {
          await removeProject(ws.name, project.id);
        } catch (e) {
          toast.error(tNotify("removeFailed", { error: String(e) }));
        }
      },
      "destructive"
    );
  }

  function handleSetAlias(ws: Workspace, project: WorkspaceProject) {
    setAliasWorkspaceName(ws.name);
    setAliasProjectId(project.id);
    setAliasValue(project.alias || "");
    setAliasDialogOpen(true);
  }

  async function confirmSetAlias() {
    try {
      await updateProjectAlias(aliasWorkspaceName, aliasProjectId, aliasValue.trim() || null);
      setAliasDialogOpen(false);
    } catch (e) {
      toast.error(tNotify("setAliasFailed", { error: String(e) }));
    }
  }

  function handleSetWorkspaceAlias(ws: Workspace) {
    setWsAliasTargetName(ws.name);
    setWsAliasValue(ws.alias || "");
    setWsAliasDialogOpen(true);
  }

  async function confirmSetWorkspaceAlias() {
    try {
      await updateWorkspaceAlias(wsAliasTargetName, wsAliasValue.trim() || null);
      setWsAliasDialogOpen(false);
    } catch (e) {
      toast.error(tNotify("setAliasFailed", { error: String(e) }));
    }
  }

  // ============ 扫描导入 ============

  async function handleScanImport(ws: Workspace) {
    try {
      const selected = await open({ directory: true, multiple: false, title: tSidebar("selectScanDir") });
      if (!selected) return;
      setScanTargetWorkspace(ws);
      const results = await scanDirectory(selected);
      if (results.length === 0) {
        toast.info(tNotify("noGitRepoFound"));
        return;
      }
      setScanResults(results);
      setScanDialogOpen(true);
    } catch (e) {
      toast.error(tNotify("scanFailed", { error: String(e) }));
    }
  }

  async function handleScanConfirm(paths: string[]) {
    if (!scanTargetWorkspace) return;
    const wsName = scanTargetWorkspace.name;
    let imported = 0;
    let skipped = 0;
    for (const path of paths) {
      try {
        await addProject(wsName, path);
        imported++;
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) {
      toast.info(tNotify("scanImportDone", { imported, skipped }));
    }
  }

  // ============ Git Clone ============

  function handleGitClone(ws: Workspace) {
    setGitCloneTargetWorkspace(ws.name);
    setGitCloneOpen(true);
  }

  async function handleGitCloned(clonedPath: string) {
    if (gitCloneTargetWorkspace) {
      try {
        await addProject(gitCloneTargetWorkspace, clonedPath);
      } catch (e) {
        toast.error(tNotify("addProjectFailed", { error: String(e) }));
      }
    }
  }

  // ============ 打开终端 ============

  function handleOpenWorkspace(ws: Workspace) {
    if (ws.projects.length === 0) return;
    onOpenTerminal({ path: ws.projects[0].path, workspaceName: ws.name, providerId: ws.providerId });
  }

  function handleOpenProject(project: WorkspaceProject, ws?: Workspace) {
    onOpenTerminal({ path: project.path, workspaceName: ws?.name, providerId: ws?.providerId });
  }

  async function handleSetWorkspaceProvider(ws: Workspace, providerId: string | null) {
    try {
      await updateWorkspaceProvider(ws.name, providerId);
    } catch (e) {
      toast.error(tNotify("setProviderFailed", { error: String(e) }));
    }
  }

  function handleOpenWorktree(path: string) {
    onOpenTerminal({ path });
  }

  function handleOpenMcpConfig(project: WorkspaceProject) {
    usePanesStore.getState().openMcpConfig(project.path, project.alias || getProjectName(project.path));
  }

  function handleOpenSkillManager(project: WorkspaceProject) {
    usePanesStore.getState().openSkillManager(project.path, project.alias || getProjectName(project.path));
  }

  function handleOpenMemoryManager(project: WorkspaceProject) {
    usePanesStore.getState().openMemoryManager(project.path, project.alias || getProjectName(project.path));
  }

  function handleOpenTodoManager(scope?: string, scopeRef?: string) {
    useDialogStore.getState().openTodo(scope || "global", scopeRef || "");
  }

  return {
    // Data
    gitBranches,
    worktreeCache,

    // Workspace actions
    handleCreateWorkspace,
    handleRenameWorkspace,
    handleDeleteWorkspace,
    handleSetWorkspaceAlias,
    handleSetWorkspaceProvider,
    handleOpenWorkspace,

    // Project actions
    handleImportProject,
    handleRemoveProject,
    handleSetAlias,
    handleOpenProject,
    handleOpenWorktree,
    handleOpenMcpConfig,
    handleOpenSkillManager,
    handleOpenMemoryManager,
    handleOpenTodoManager,

    // Scan / Clone
    handleScanImport,
    handleGitClone,

    // Dialog state + callbacks (passed to WorkspaceDialogs)
    dialogs: {
      newWorkspace: {
        open: newWorkspaceOpen,
        setOpen: setNewWorkspaceOpen,
        name: newWorkspaceName,
        setName: setNewWorkspaceName,
        path: newWorkspacePath,
        setPath: setNewWorkspacePath,
        onSelectPath: handleSelectNewWorkspacePath,
        onConfirm: confirmCreateWorkspace,
      },
      renameWorkspace: {
        open: renameWorkspaceOpen,
        setOpen: setRenameWorkspaceOpen,
        name: renameWorkspaceNewName,
        setName: setRenameWorkspaceNewName,
        onConfirm: confirmRenameWorkspace,
      },
      projectAlias: {
        open: aliasDialogOpen,
        setOpen: setAliasDialogOpen,
        value: aliasValue,
        setValue: setAliasValue,
        onConfirm: confirmSetAlias,
      },
      workspaceAlias: {
        open: wsAliasDialogOpen,
        setOpen: setWsAliasDialogOpen,
        value: wsAliasValue,
        setValue: setWsAliasValue,
        onConfirm: confirmSetWorkspaceAlias,
      },
      scan: {
        open: scanDialogOpen,
        setOpen: setScanDialogOpen,
        results: scanResults,
        onConfirm: handleScanConfirm,
      },
      gitClone: {
        open: gitCloneOpen,
        setOpen: setGitCloneOpen,
        workspaceName: gitCloneTargetWorkspace,
        onCloned: handleGitCloned,
      },
      confirm: {
        open: confirmOpen,
        setOpen: setConfirmOpen,
        title: confirmTitle,
        description: confirmDescription,
        onConfirm: handleConfirm,
        variant: confirmVariant,
      },
    },
  };
}
