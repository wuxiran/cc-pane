// 启动页的工作空间→项目下拉（含「浏览目录」兜底）。hero 无目录态的大按钮与
// composer 里的目录 chip 共用同一份菜单，只换 trigger。
import { Fragment, useCallback, useMemo, type ReactNode } from "react";
import { FolderOpen, Layers } from "lucide-react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { samePath } from "./chatPaths";

export function projectNameOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

export interface StartProjectMenuProps {
  cwd: string;
  onPickCwd: (cwd: string) => void;
  trigger: ReactNode;
}

export default function StartProjectMenu({ cwd, onPickCwd, trigger }: StartProjectMenuProps) {
  const { t } = useTranslation("panes");
  const workspaces = useWorkspacesStore((state) => state.workspaces);

  // 注册的工作空间→项目树（归档过滤在消费点，CLAUDE.md 约定）。
  // 工作空间自己有根目录时（用户建工作空间时选的文件夹）也可直接选中——agent 以
  // 工作空间根为 cwd，跨其下多个项目干活（workspace-first）。默认工作空间的 path
  // 是数据目录，不当项目用（docs/98）。
  const workspaceTree = useMemo(
    () =>
      workspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.alias || workspace.name,
          rootPath: !workspace.isDefault && workspace.path ? workspace.path : null,
          projects: workspace.projects.filter((project) => !project.archivedAt),
        }))
        .filter((workspace) => workspace.projects.length > 0 || workspace.rootPath),
    [workspaces],
  );

  const pickCwd = useCallback(async () => {
    const picked = await openDirDialog({ multiple: false, directory: true }).catch(() => null);
    if (typeof picked === "string" && picked) onPickCwd(picked);
  }, [onPickCwd]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {workspaceTree.map((workspace) => (
          <Fragment key={workspace.id}>
            {workspace.rootPath ? (
              <DropdownMenuItem
                title={`${t("agentChatWorkspaceRoot")} · ${workspace.rootPath}`}
                onSelect={() => onPickCwd(workspace.rootPath!)}
                className="text-[10px] uppercase tracking-wide text-[var(--app-icon-inactive)] data-[highlighted]:text-[var(--app-text-primary)]"
              >
                <Layers className="mr-2 h-3.5 w-3.5 shrink-0" />
                <span className="max-w-56 truncate">{workspace.name}</span>
                <span className="ml-2 normal-case tracking-normal opacity-70">
                  {t("agentChatWorkspaceRoot")}
                </span>
                {cwd && samePath(workspace.rootPath, cwd) ? (
                  <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
                ) : null}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-[var(--app-icon-inactive)]">
                {workspace.name}
              </DropdownMenuLabel>
            )}
            {workspace.projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                title={project.path}
                onSelect={() => onPickCwd(project.path)}
              >
                <FolderOpen className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" />
                <span className="max-w-56 truncate">
                  {project.alias || projectNameOf(project.path)}
                </span>
                {cwd && samePath(project.path, cwd) ? (
                  <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
        {workspaceTree.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => void pickCwd()}>
          <FolderOpen className="mr-2 h-3.5 w-3.5 shrink-0" />
          {t("agentChatBrowseDir")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
