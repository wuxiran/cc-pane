// 启动页输入框上方的托盘：运行环境/worktree 弹层 + 项目（或远程目标）+ 审查入口。
// 从 EnginePicker 拆出（行数棘轮）。远程目标时不挂任何作用于本地路径的入口。
import { useMemo, type ReactElement, type ReactNode } from "react";
import { FileDiff, FolderOpen, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import LocalLaunchSettings from "@/components/launcher/LocalLaunchSettings";
import type { WorkspaceProjectCandidate } from "@/components/launcher/useWorkspaceGitProjects";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { AgentChatRemoteTarget } from "@/stores/useAgentChatRemoteStore";
import type { Workspace } from "@/types";
import type { LocalWorktreeDraft } from "@/types/localLaunch";
import { samePath } from "./chatPaths";
import ChatEnvironmentControls from "./ChatEnvironmentControls";
import { useChatRuntimeTools } from "./ChatRuntimeWorkspace";
import { projectNameOf } from "./StartProjectMenu";

/** cwd 是（非默认）工作空间根时，其下可在本机做 worktree 的项目。 */
export function workspaceProjectsFor(cwd: string, workspaces: Workspace[]): WorkspaceProjectCandidate[] | undefined {
  const workspace = workspaces.find((item) => !item.archivedAt && !item.isDefault && item.path && samePath(item.path, cwd));
  if (!workspace) return undefined;
  return workspace.projects
    .filter((project) => !project.archivedAt && !project.ssh && !project.wslRemotePath)
    .map((project) => ({ path: project.path, name: project.alias || projectNameOf(project.path) }));
}

interface StartTrayProps {
  chatId: string;
  cwd: string;
  projectName: string | null;
  busy: boolean;
  worktree?: LocalWorktreeDraft;
  onWorktreeChange: (worktree: LocalWorktreeDraft) => void;
  projectMenu: (trigger: ReactElement) => ReactNode;
  remote: AgentChatRemoteTarget | null;
  remoteLabel: string | null;
}

export default function StartTray({
  chatId, cwd, projectName, busy, worktree, onWorktreeChange, projectMenu, remote, remoteLabel,
}: StartTrayProps) {
  const { t } = useTranslation("panes");
  const { t: reviewT } = useTranslation("review");
  const runtimeTools = useChatRuntimeTools();
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const workspaceProjects = useMemo(() => workspaceProjectsFor(cwd, workspaces), [cwd, workspaces]);
  return (
    <div className="agent-chat-start-tray mx-4 flex min-w-0 items-center gap-1 rounded-t-2xl border border-b-0 border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-text-secondary)]">
      <LocalLaunchSettings projectPath={cwd} isLocal={!remote} worktree={worktree}
        onChange={onWorktreeChange} disabled={busy} workspaceProjects={workspaceProjects}
        environmentLabel={remote?.machineName}
        environmentControls={<ChatEnvironmentControls chatId={chatId} disabled={busy} />} />
      {remote ? (
        <span data-testid="start-remote-target" title={t("agentChatRemoteTargetTip", { host: remote.host, path: remote.cwd })}
          className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
          <Server className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 max-w-64 truncate">{remoteLabel}</span>
        </span>
      ) : projectMenu(
        <button
          type="button"
          title={cwd}
          disabled={busy}
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 max-w-64 truncate">{projectName}</span>
        </button>,
      )}
      <span className="min-w-0 flex-1" />
      {runtimeTools && !remote && <Tooltip><TooltipTrigger asChild><button type="button" aria-label={reviewT("title")} onClick={() => runtimeTools.openReview(cwd)}
        className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]">
        <FileDiff className="h-3.5 w-3.5" />
      </button></TooltipTrigger><TooltipContent>{reviewT("title")}</TooltipContent></Tooltip>}
    </div>
  );
}
