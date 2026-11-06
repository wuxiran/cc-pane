// 右侧面板窄版启动页的上半部分：项目名 + 一句提示、竖排的起点建议、本项目最近 3 条对话。
// 比窗格启动页轻（无大标题、无运行环境/审查/运行记录、无过滤和重命名），但不留大片空白。
import { Bot, Bug, Hammer, History, SearchCode, Telescope } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { samePath } from "./chatPaths";

export const START_SUGGESTIONS = [
  { icon: Telescope, labelKey: "agentChatSuggestExplore", promptKey: "agentChatSuggestExplorePrompt" },
  { icon: Hammer, labelKey: "agentChatSuggestBuild", promptKey: "agentChatSuggestBuildPrompt" },
  { icon: SearchCode, labelKey: "agentChatSuggestReview", promptKey: "agentChatSuggestReviewPrompt" },
  { icon: Bug, labelKey: "agentChatSuggestFix", promptKey: "agentChatSuggestFixPrompt" },
] as const;

const RECENT_LIMIT = 3;

export function recentForProject(entries: AcpChatHistoryEntry[], cwd: string): AcpChatHistoryEntry[] {
  return entries
    .filter((entry) => entry.acpSessionId && samePath(entry.cwd, cwd))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT);
}

interface CompactStartIntroProps {
  projectName: string | null;
  cwd: string;
  entries: AcpChatHistoryEntry[];
  disabled: boolean;
  onSuggest: (prompt: string) => void;
  onResume: (entry: AcpChatHistoryEntry) => void;
}

export default function CompactStartIntro({ projectName, cwd, entries, disabled, onSuggest, onResume }: CompactStartIntroProps) {
  const { t } = useTranslation("panes");
  const recent = cwd ? recentForProject(entries, cwd) : [];
  return (
    <div className="flex flex-col gap-4 px-1" data-testid="compact-start-intro">
      <div className="flex items-center gap-2.5">
        <Bot className="size-5 shrink-0 text-[var(--app-text-tertiary)]" strokeWidth={1.6} />
        <div className="min-w-0">
          <div className="truncate text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">
            {projectName ?? t("agentChatNoProject")}
          </div>
          {projectName && <div className="text-xs text-[var(--app-text-tertiary)]">{t("agentChatHeroSub")}</div>}
        </div>
      </div>

      {cwd && (
        <div className="flex flex-col gap-1">
          {START_SUGGESTIONS.map(({ icon: Icon, labelKey, promptKey }) => (
            <button
              key={labelKey}
              type="button"
              disabled={disabled}
              onClick={() => onSuggest(t(promptKey))}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:opacity-50"
            >
              <Icon className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" />
              <span className="truncate">{t(labelKey)}</span>
            </button>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 px-2 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
            <History className="size-3" /> {t("agentChatHistoryTitle")}
          </div>
          {recent.map((entry) => (
            <button
              key={entry.acpSessionId}
              type="button"
              disabled={disabled}
              data-testid="compact-recent-session"
              onClick={() => onResume(entry)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
            >
              <span className="min-w-0 flex-1 truncate text-[var(--app-text-secondary)]">{entry.title || entry.acpSessionId}</span>
              <span className="shrink-0 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
                {new Date(entry.updatedAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
