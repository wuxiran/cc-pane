// Explorer 侧栏「Agent 会话」区：跨项目的最近 ACP 对话列表（CodexHost 式
// 全局会话入口）。点击 = 开新 agent-chat 标签并自动续接（pendingResume 交接，
// EnginePicker 挂载时领取）。顶部：新对话 + 自动化（跳设置对应节）。
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, MessagesSquare, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { setPendingResume } from "@/components/agentchat/pendingResume";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { useActivityBarStore, usePanesStore, useWorkspacesStore } from "@/stores";
import { handleErrorSilent } from "@/utils/errorHandler";

function projectNameOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

export default function AgentChatSessionsView() {
  const { t } = useTranslation("sidebar");
  const [entries, setEntries] = useState<AcpChatHistoryEntry[]>([]);
  const expandedWorkspace = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.expandedWorkspaceId) ?? null,
  );
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);

  const reload = useCallback(() => {
    agentChatService
      .listHistory()
      .then((list) => setEntries(list.filter((entry) => entry.acpSessionId)))
      .catch((error) => handleErrorSilent(error, "list acp chat history"));
  }, []);

  useEffect(() => {
    reload();
    // 列表在切回本视图时刷新即可（keep-alive 下靠 focus 兜底）。
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const openNew = useCallback(() => {
    const projectPath = expandedWorkspace?.projects.find(
      (project) => project.id === expandedProjectId,
    )?.path;
    usePanesStore.getState().openAgentChat(projectPath || undefined);
    useActivityBarStore.getState().setAppViewMode("panes");
  }, [expandedWorkspace, expandedProjectId]);

  const resume = useCallback((entry: AcpChatHistoryEntry) => {
    const tabId = usePanesStore.getState().openAgentChat(entry.cwd);
    if (tabId) {
      setPendingResume(tabId, {
        engineId: entry.engineId,
        cwd: entry.cwd,
        acpSessionId: entry.acpSessionId,
      });
    }
    useActivityBarStore.getState().setAppViewMode("panes");
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-1">
        <span className="text-[11px] font-medium text-[var(--app-text-secondary)]">
          {t("agentChatsTitle")}
        </span>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("agentChatsAutomations")}
              className="rounded p-1 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
              onClick={() => navigateToSettings({ paneId: "automations" })}
            >
              <CalendarClock className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("agentChatsAutomations")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("newAgentChat")}
              className="rounded p-1 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
              onClick={openNew}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("newAgentChat")}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-[11px] text-[var(--app-icon-inactive)]">
            <MessagesSquare className="h-6 w-6 opacity-40" />
            {t("agentChatsEmpty")}
          </div>
        ) : (
          entries.slice(0, 50).map((entry) => (
            <button
              key={entry.acpSessionId}
              type="button"
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)]"
              onClick={() => resume(entry)}
            >
              <span className="flex items-center gap-1.5">
                <span className="flex-1 truncate text-xs text-[var(--app-text-primary)]">
                  {entry.title || entry.acpSessionId}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--app-icon-inactive)]">
                  {entry.engineId}
                </span>
              </span>
              <span className="truncate text-[10px] text-[var(--app-icon-inactive)]">
                {projectNameOf(entry.cwd)} · {formatTime(entry.updatedAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
