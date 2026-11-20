// 资源管理器下半部分的「最近」：最近的会话（终端会话 + Agent 对话），按时间倒序。
// 每行只有一行标题，点一下恢复；悬浮弹出这段会话的详情；右键有重命名、置顶、复制、移除。
// 完整的搜索在搜索面板里。
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, SquarePen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openPaletteSession, usePaletteSessions } from "@/components/commandPalette/PaletteSessions";
import { applyRecentSessionPrefs, useRecentSessionPrefsStore } from "@/stores/useRecentSessionPrefsStore";
import RecentSessionRow from "./RecentSessionRow";
import { useExplorerSectionsStore } from "@/stores/useExplorerSectionsStore";
import { useWorkspacesStore } from "@/stores";
import type { OpenTerminalOptions } from "@/types";
import { openNewAgentChat } from "./agentChatResume";

/** 侧栏里最多列这么多条，更早的去搜索面板找。 */
export const RECENT_SESSIONS_LIMIT = 30;

interface RecentSessionsSectionProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function RecentSessionsSection({ onOpenTerminal }: RecentSessionsSectionProps) {
  const { t } = useTranslation("sidebar");
  const collapsed = useExplorerSectionsStore((s) => s.recentCollapsed);
  const toggle = useExplorerSectionsStore((s) => s.toggleRecentCollapsed);
  const all = usePaletteSessions(true);
  const pinned = useRecentSessionPrefsStore((s) => s.pinned);
  const hidden = useRecentSessionPrefsStore((s) => s.hidden);
  const titles = useRecentSessionPrefsStore((s) => s.titles);
  // 置顶的排最前、移除的不显示、自己起的名字优先；更早的会话去搜索面板找。
  const sessions = applyRecentSessionPrefs(all, { pinned, hidden, titles }, RECENT_SESSIONS_LIMIT);
  const rolloutMissing = t("sessionHistory.rolloutMissing");
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  const newChat = () => {
    const state = useWorkspacesStore.getState();
    const workspace = state.workspaces.find((item) => item.id === state.expandedWorkspaceId);
    openNewAgentChat(workspace?.projects.find((project) => project.id === state.expandedProjectId)?.path);
  };

  return (
    <section
      data-testid="recent-sessions"
      // 展开时占满树下面剩余的高度（列表自己滚动），至少留 160px；收起时只剩分区头，留在原位。
      className={`flex flex-col px-3 pt-1 ${collapsed ? "shrink-0 pb-1.5" : "min-h-[160px] flex-1 pb-2"}`}
    >
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-[length:var(--text-caption)] font-medium text-[var(--app-text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--app-text-secondary)]"
        >
          {t("recentSessions.title")}
          <Chevron className="size-3.5 shrink-0" strokeWidth={1.8} />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("newAgentChat")}
              onClick={newChat}
              className="flex h-[24px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--app-text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
            >
              <SquarePen className="size-3.5" strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("newAgentChat")}</TooltipContent>
        </Tooltip>
      </div>
      {!collapsed && (
        <div className="app-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t("recentSessions.empty")}</p>
          ) : (
            sessions.map((session) => (
              <RecentSessionRow
                key={session.key}
                session={session}
                pinned={pinned.includes(session.key)}
                onOpen={() => openPaletteSession(session, onOpenTerminal, rolloutMissing)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
