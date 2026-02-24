import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  Folder, ChevronRight, Trash2, Plus, Pencil, FileText, Clock,
  FolderOpen, FolderSearch, ShieldCheck, Terminal, Cloud, Check, GitBranch,
  FolderRoot, X, Copy,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore, useProvidersStore, useThemeStore, useDialogStore } from "@/stores";
import { worktreeService, type WorktreeInfo } from "@/services";
import { scanDirectory, type ScannedRepo } from "@/services/workspaceService";
import ScanImportDialog from "@/components/ScanImportDialog";
import GitCloneDialog from "@/components/GitCloneDialog";
import { getProjectName } from "@/utils";
import type { Workspace, WorkspaceProject } from "@/types";

interface WorkspaceTreeProps {
  onOpenTerminal: (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean) => void;
}

export default function WorkspaceTree({
  onOpenTerminal,
}: WorkspaceTreeProps) {
  const onOpenJournal = useDialogStore((s) => s.openJournal);
  const onOpenHistory = useDialogStore((s) => s.openLocalHistory);
  const onOpenSessionCleaner = useDialogStore((s) => s.openSessionCleaner);
  const isDark = useThemeStore((s) => s.isDark);

  // Workspace 状态
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const createWorkspace = useWorkspacesStore((s) => s.create);
  const renameWs = useWorkspacesStore((s) => s.rename);
  const removeWorkspace = useWorkspacesStore((s) => s.remove);
  const addProject = useWorkspacesStore((s) => s.addProject);
  const removeProject = useWorkspacesStore((s) => s.removeProject);
  const updateProjectAlias = useWorkspacesStore((s) => s.updateProjectAlias);
  const updateWorkspaceAlias = useWorkspacesStore((s) => s.updateWorkspaceAlias);
  const updateWorkspaceProvider = useWorkspacesStore((s) => s.updateWorkspaceProvider);
  const updateWorkspacePath = useWorkspacesStore((s) => s.updateWorkspacePath);
  const expandWorkspace = useWorkspacesStore((s) => s.expandWorkspace);
  const expandProject = useWorkspacesStore((s) => s.expandProject);

  const providerList = useProvidersStore((s) => s.providers);

  // 本地状态
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

  // 确认对话框
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState("");
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(null);

  // 扫描导入
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const [scanResults, setScanResults] = useState<ScannedRepo[]>([]);
  const [scanTargetWorkspace, setScanTargetWorkspace] = useState<Workspace | null>(null);

  // Git Clone
  const [gitCloneOpen, setGitCloneOpen] = useState(false);
  const [gitCloneTargetWorkspace, setGitCloneTargetWorkspace] = useState<string>("");

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
    if (!expandedProjectId) return;
    const currentWorkspaces = useWorkspacesStore.getState().workspaces;
    for (const ws of currentWorkspaces) {
      const project = ws.projects.find((p) => p.id === expandedProjectId);
      if (project) {
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
        break;
      }
    }
  }, [expandedProjectId, fetchGitBranch, fetchWorktrees]);

  function getWorkspaceName(ws: Workspace): string {
    return ws.alias || ws.name;
  }

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
      toast.error(`选择路径失败: ${e}`);
    }
  }

  async function confirmCreateWorkspace() {
    if (!newWorkspaceName.trim() || !newWorkspacePath.trim()) return;
    try {
      await createWorkspace(newWorkspaceName.trim(), newWorkspacePath.trim());
      setNewWorkspaceOpen(false);
    } catch (e) {
      toast.error(`创建失败: ${e}`);
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
      toast.error(`重命名失败: ${e}`);
    }
  }

  function handleDeleteWorkspace(ws: Workspace) {
    setConfirmMessage(`确定要删除工作空间 "${ws.name}" 吗？`);
    setConfirmCallback(() => async () => {
      try {
        await removeWorkspace(ws.name);
      } catch (e) {
        toast.error(`删除失败: ${e}`);
      }
    });
    setConfirmOpen(true);
  }

  // ============ 项目操作 ============

  async function handleImportProject(ws: Workspace) {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (selected) {
        await addProject(ws.name, selected);
      }
    } catch (e) {
      toast.error(`导入失败: ${e}`);
    }
  }

  function handleRemoveProject(ws: Workspace, project: WorkspaceProject) {
    setConfirmMessage(`确定要从工作空间移除项目 "${project.alias || getProjectName(project.path)}" 吗？`);
    setConfirmCallback(() => async () => {
      try {
        await removeProject(ws.name, project.id);
      } catch (e) {
        toast.error(`移除失败: ${e}`);
      }
    });
    setConfirmOpen(true);
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
      toast.error(`设置别名失败: ${e}`);
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
      toast.error(`设置别名失败: ${e}`);
    }
  }

  // ============ 扫描导入 ============

  async function handleScanImport(ws: Workspace) {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择要扫描的根目录" });
      if (!selected) return;
      setScanTargetWorkspace(ws);
      const results = await scanDirectory(selected);
      if (results.length === 0) {
        toast.info("未在该目录下发现任何 Git 仓库");
        return;
      }
      setScanResults(results);
      setScanDialogOpen(true);
    } catch (e) {
      toast.error(`扫描失败: ${e}`);
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
      toast.info(`导入完成: ${imported} 个成功, ${skipped} 个跳过（可能已存在）`);
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
        toast.error(`添加项目失败: ${e}`);
      }
    }
  }

  // ============ 打开终端 ============

  function handleOpenWorkspace(ws: Workspace) {
    if (ws.projects.length === 0) return;
    onOpenTerminal(ws.projects[0].path, ws.name, ws.providerId);
  }

  function handleOpenProject(project: WorkspaceProject, ws?: Workspace) {
    onOpenTerminal(project.path, ws?.name, ws?.providerId);
  }

  function handleOpenClaudeWorkspace(ws: Workspace) {
    if (ws.projects.length === 0) return;
    onOpenTerminal(ws.projects[0].path, ws.name, ws.providerId, ws.path, true);
  }

  function handleOpenClaudeProject(project: WorkspaceProject, ws?: Workspace) {
    onOpenTerminal(project.path, ws?.name, ws?.providerId, ws?.path, true);
  }

  async function handleSetWorkspacePath(ws: Workspace) {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择工作空间根目录" });
      if (selected) {
        await updateWorkspacePath(ws.name, selected);
        toast.success("工作空间路径已设置");
      }
    } catch (e) {
      toast.error(`设置路径失败: ${e}`);
    }
  }

  async function handleClearWorkspacePath(ws: Workspace) {
    try {
      await updateWorkspacePath(ws.name, null);
      toast.success("工作空间路径已清除");
    } catch (e) {
      toast.error(`清除路径失败: ${e}`);
    }
  }

  async function handleSetWorkspaceProvider(ws: Workspace, providerId: string | null) {
    try {
      await updateWorkspaceProvider(ws.name, providerId);
    } catch (e) {
      toast.error(`设置 Provider 失败: ${e}`);
    }
  }

  function handleOpenWorktree(path: string) {
    onOpenTerminal(path);
  }

  async function handleRevealFolder(path: string) {
    try {
      await openPath(path);
    } catch (e) {
      toast.error(`打开文件夹失败: ${e}`);
    }
  }

  async function handleCopyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      toast.success("已复制到剪贴板");
    } catch (e) {
      toast.error(`复制失败: ${e}`);
    }
  }

  function getRelativePath(projectPath: string, wsPath?: string | null): string {
    const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (wsPath) {
      const normBase = normalize(wsPath);
      const normFull = normalize(projectPath);
      if (normFull.startsWith(normBase + "/")) {
        return normFull.slice(normBase.length + 1);
      }
    }
    const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.pop() || projectPath;
  }

  return (
    <>
      {/* Section: 工作空间 */}
      <div className="flex items-center justify-between px-3 py-3 mt-1 mb-1">
        <span className={`text-[11px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>工作空间</span>
      </div>

      <div className="flex flex-col gap-1">
        {workspaces.map((ws) => (
          <div key={ws.id}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  className={`w-full group flex items-center justify-between px-3 py-2.5 mb-1 rounded-xl transition-all duration-300 border border-transparent ${
                    expandedWorkspaceId === ws.id
                      ? isDark
                        ? 'bg-gradient-to-r from-blue-500/20 to-blue-500/5 text-blue-200 border-white/10 shadow-[0_4px_20px_rgba(59,130,246,0.15)] backdrop-blur-md'
                        : 'bg-white/50 text-blue-600 shadow-lg shadow-blue-500/5 ring-1 ring-white/80 backdrop-blur-md'
                      : isDark
                        ? 'text-slate-400 hover:bg-white/5 hover:text-slate-200 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)]'
                        : 'text-slate-500 hover:bg-white/40 hover:text-slate-900 hover:shadow-sm'
                  }`}
                  onClick={() => expandWorkspace(ws.id)}
                >
                  <div className="flex items-center gap-3">
                    <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expandedWorkspaceId === ws.id ? 'rotate-90' : ''}`} />
                    <span className="text-sm font-medium tracking-wide">{getWorkspaceName(ws)}</span>
                    {ws.path && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                        isDark ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                      }`}>
                        Claude
                      </span>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full backdrop-blur-sm ${
                    expandedWorkspaceId === ws.id
                      ? isDark ? 'bg-blue-400/20 text-blue-100 border border-blue-400/20' : 'bg-blue-100/60 text-blue-700 shadow-sm'
                      : isDark ? 'bg-slate-800/40 text-slate-500 border border-white/5' : 'bg-white/50 text-slate-500 shadow-sm'
                  }`}>
                    {ws.projects.length}
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-40">
                <ContextMenuItem disabled={ws.projects.length === 0} onClick={() => handleOpenWorkspace(ws)}>
                  <Terminal size={14} className="mr-2" /> 打开终端
                </ContextMenuItem>
                <ContextMenuItem disabled={ws.projects.length === 0} onClick={() => handleOpenClaudeWorkspace(ws)}>
                  <Terminal size={14} className="mr-2" /> 打开 Claude Code
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!ws.path && ws.projects.length === 0}
                  onClick={() => handleRevealFolder(ws.path || ws.projects[0]?.path)}
                >
                  <FolderOpen size={14} className="mr-2" /> 打开文件夹
                </ContextMenuItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger disabled={!ws.path && ws.projects.length === 0}>
                    <Copy size={14} className="mr-2" /> 复制路径
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <ContextMenuItem onClick={() => handleCopyPath(ws.path || ws.projects[0]?.path)}>
                      绝对路径
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleCopyPath(getRelativePath(ws.path || ws.projects[0]?.path))}>
                      相对路径
                    </ContextMenuItem>
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onOpenJournal(ws.name)}>
                  <FileText size={14} className="mr-2" /> 会话日志
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onOpenSessionCleaner(ws.name)}>
                  <ShieldCheck size={14} className="mr-2" /> 会话修复
                </ContextMenuItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Cloud size={14} className="mr-2" /> Provider
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-44">
                    <ContextMenuItem onClick={() => handleSetWorkspaceProvider(ws, null)}>
                      {!ws.providerId ? <Check size={14} className="mr-2" /> : <span className="mr-2 w-[14px]" />}
                      不指定（继承系统）
                    </ContextMenuItem>
                    {providerList.length > 0 && <ContextMenuSeparator />}
                    {providerList.map((p) => (
                      <ContextMenuItem key={p.id} onClick={() => handleSetWorkspaceProvider(ws, p.id)}>
                        {ws.providerId === p.id ? <Check size={14} className="mr-2" /> : <span className="mr-2 w-[14px]" />}
                        {p.name}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleSetWorkspacePath(ws)}>
                  <FolderRoot size={14} className="mr-2" /> 设置工作空间路径
                </ContextMenuItem>
                {ws.path && (
                  <ContextMenuItem onClick={() => handleClearWorkspacePath(ws)}>
                    <X size={14} className="mr-2" /> 清除工作空间路径
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleScanImport(ws)}>
                  <FolderSearch size={14} className="mr-2" /> 从目录导入
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleGitClone(ws)}>
                  <GitBranch size={14} className="mr-2" /> 从 Git 克隆
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleSetWorkspaceAlias(ws)}>
                  <Pencil size={14} className="mr-2" /> 设置别名
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleRenameWorkspace(ws)}>
                  <Pencil size={14} className="mr-2" /> 重命名
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem className="text-destructive" onClick={() => handleDeleteWorkspace(ws)}>
                  <Trash2 size={14} className="mr-2" /> 删除
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            {/* 展开的项目列表 */}
            {expandedWorkspaceId === ws.id && (
              <div className="pl-4 pr-1 pb-2 flex flex-col gap-0.5">
                {ws.projects.map((project) => (
                  <div key={project.id}>
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer rounded-lg transition-all ${
                            expandedProjectId === project.id
                              ? isDark
                                ? 'bg-white/5 text-slate-200'
                                : 'bg-white/40 text-slate-800 shadow-sm'
                              : isDark
                                ? 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                                : 'text-slate-500 hover:bg-white/30 hover:text-slate-800'
                          }`}
                          onClick={() => expandProject(project.id)}
                          onDoubleClick={() => handleOpenProject(project, ws)}
                        >
                          <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${expandedProjectId === project.id ? 'rotate-90' : ''}`} />
                          <Folder size={14} className="shrink-0" style={{ color: "var(--app-accent)" }} />
                          <span className="flex-1 text-xs truncate">{project.alias || getProjectName(project.path)}</span>
                          {gitBranches[project.path] && (
                            <span className="text-[10px] px-1 rounded shrink-0" style={{ color: "var(--app-accent)", background: "var(--app-active-bg)" }}>
                              {gitBranches[project.path]}
                            </span>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-44">
                        <ContextMenuItem onClick={() => handleOpenProject(project, ws)}>
                          <Terminal size={14} className="mr-2" /> 打开终端
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => handleOpenClaudeProject(project, ws)}>
                          <Terminal size={14} className="mr-2" /> 打开 Claude Code
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => handleRevealFolder(project.path)}>
                          <FolderOpen size={14} className="mr-2" /> 打开文件夹
                        </ContextMenuItem>
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            <Copy size={14} className="mr-2" /> 复制路径
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            <ContextMenuItem onClick={() => handleCopyPath(project.path)}>
                              绝对路径
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => handleCopyPath(getRelativePath(project.path, ws.path))}>
                              相对路径
                            </ContextMenuItem>
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => handleSetAlias(ws, project)}>
                          <Pencil size={14} className="mr-2" /> 设置别名
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onOpenHistory(project.path)}>
                          <Clock size={14} className="mr-2" /> 文件历史
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem className="text-destructive" onClick={() => handleRemoveProject(ws, project)}>
                          <Trash2 size={14} className="mr-2" /> 移除项目
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>

                    {/* Worktree 列表 */}
                    {expandedProjectId === project.id && (
                      <div className="ml-6 py-1 flex flex-col gap-0.5">
                        {(worktreeCache[project.path] || []).map((wt) => (
                          <div
                            key={wt.path}
                            className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded-lg transition-colors ${
                              isDark ? 'hover:bg-white/5' : 'hover:bg-white/30'
                            }`}
                            onClick={() => handleOpenWorktree(wt.path)}
                          >
                            <FolderOpen size={12} className="shrink-0" style={{ color: "var(--app-text-tertiary)" }} />
                            <span className="flex-1 text-[11px] truncate" style={{ color: "var(--app-text-secondary)" }}>
                              {wt.isMain ? "主目录" : wt.branch || wt.path}
                            </span>
                            {wt.isMain && (
                              <Badge variant="outline" className="text-[9px] px-1 h-4">
                                主
                              </Badge>
                            )}
                          </div>
                        ))}
                        {!worktreeCache[project.path]?.length && (
                          <div className="text-[11px] px-2 py-1" style={{ color: "var(--app-text-tertiary)" }}>
                            无 Worktree
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {/* 导入项目按钮 */}
                <div
                  className={`flex items-center justify-center gap-1 p-1.5 mt-1 text-[11px] rounded-lg cursor-pointer transition-all border border-dashed group ${
                    isDark
                      ? 'border-white/10 text-slate-400 hover:border-blue-500/50 hover:text-blue-300 hover:bg-blue-500/10'
                      : 'border-slate-400/30 text-slate-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50/50'
                  }`}
                  onClick={() => handleImportProject(ws)}
                >
                  <Plus size={12} className="transition-transform group-hover:rotate-90" />
                  <span>导入项目</span>
                </div>
              </div>
            )}
          </div>
        ))}

        {workspaces.length === 0 && (
          <div className={`text-xs text-center py-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            暂无工作空间
          </div>
        )}
      </div>

      {/* 新建工作空间按钮 */}
      <button
        className={`w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed text-xs font-medium transition-all group backdrop-blur-sm ${
          isDark
            ? 'border-white/10 text-slate-400 hover:border-blue-500/50 hover:text-blue-300 hover:bg-blue-500/10'
            : 'border-slate-400/30 text-slate-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50/50'
        }`}
        onClick={handleCreateWorkspace}
      >
        <Plus className="w-3.5 h-3.5 transition-transform group-hover:rotate-90" />
        新建工作空间
      </button>

      {/* Section: 工具 */}
      <div className="flex items-center justify-between px-3 py-3 mt-4 mb-1">
        <span className={`text-[11px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>工具</span>
      </div>
      <button
        className={`w-full group flex items-center justify-between px-3 py-2.5 mb-1 rounded-xl transition-all duration-300 border border-transparent ${
          isDark
            ? 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            : 'text-slate-500 hover:bg-white/40 hover:text-slate-900 hover:shadow-sm'
        }`}
        onClick={() => onOpenHistory("")}
      >
        <div className="flex items-center gap-3">
          <Clock className="w-4 h-4 text-slate-400 group-hover:text-slate-500" />
          <span className="text-sm font-medium tracking-wide">文件历史</span>
        </div>
      </button>

      {/* Dialogs */}
      <Dialog open={newWorkspaceOpen} onOpenChange={setNewWorkspaceOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>新建工作空间</DialogTitle></DialogHeader>
          <div className="py-4 flex flex-col gap-3">
            <Input
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="工作空间名称"
              onKeyDown={(e) => e.key === "Enter" && confirmCreateWorkspace()}
            />
            <div className="flex gap-2">
              <Input
                value={newWorkspacePath}
                readOnly
                placeholder="选择工作空间根目录"
                className="flex-1"
              />
              <Button variant="secondary" onClick={handleSelectNewWorkspacePath}>
                <FolderOpen size={14} className="mr-1" /> 浏览
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setNewWorkspaceOpen(false)}>取消</Button>
            <Button onClick={confirmCreateWorkspace} disabled={!newWorkspaceName.trim() || !newWorkspacePath.trim()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameWorkspaceOpen} onOpenChange={setRenameWorkspaceOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>重命名工作空间</DialogTitle></DialogHeader>
          <div className="py-4">
            <Input
              value={renameWorkspaceNewName}
              onChange={(e) => setRenameWorkspaceNewName(e.target.value)}
              placeholder="新名称"
              onKeyDown={(e) => e.key === "Enter" && confirmRenameWorkspace()}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRenameWorkspaceOpen(false)}>取消</Button>
            <Button onClick={confirmRenameWorkspace}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={aliasDialogOpen} onOpenChange={setAliasDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>设置项目别名</DialogTitle></DialogHeader>
          <div className="py-4">
            <Input
              value={aliasValue}
              onChange={(e) => setAliasValue(e.target.value)}
              placeholder="留空则使用文件夹名"
              onKeyDown={(e) => e.key === "Enter" && confirmSetAlias()}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAliasDialogOpen(false)}>取消</Button>
            <Button onClick={confirmSetAlias}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={wsAliasDialogOpen} onOpenChange={setWsAliasDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>设置工作空间别名</DialogTitle></DialogHeader>
          <div className="py-4">
            <Input
              value={wsAliasValue}
              onChange={(e) => setWsAliasValue(e.target.value)}
              placeholder="留空则使用原始名称"
              onKeyDown={(e) => e.key === "Enter" && confirmSetWorkspaceAlias()}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setWsAliasDialogOpen(false)}>取消</Button>
            <Button onClick={confirmSetWorkspaceAlias}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ScanImportDialog
        open={scanDialogOpen}
        onOpenChange={setScanDialogOpen}
        repos={scanResults}
        onConfirm={handleScanConfirm}
      />

      <GitCloneDialog
        open={gitCloneOpen}
        onOpenChange={setGitCloneOpen}
        workspaceName={gitCloneTargetWorkspace}
        onCloned={handleGitCloned}
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>确认操作</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">{confirmMessage}</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                confirmCallback?.();
              }}
            >
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
