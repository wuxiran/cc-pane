// 会话首屏欢迎态：说明现在在和谁说话（引擎 / 编排管家）、工作目录在哪。
// 放在消息流顶部，不进 store——它不是消息，是会话头。
import { Bot, FolderOpen, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectNameOf } from "./StartProjectMenu";

interface ChatWelcomeProps {
  engineLabel: string;
  cwd: string;
  concierge: boolean;
}

export default function ChatWelcome({ engineLabel, cwd, concierge }: ChatWelcomeProps) {
  const { t } = useTranslation("panes");
  const Icon = concierge ? Sparkles : Bot;
  return (
    <div
      data-testid="chat-welcome"
      className="flex items-start gap-3 rounded-xl border border-dashed border-[var(--app-border)] px-4 py-3"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--app-active-bg)] text-[var(--app-accent)]">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--app-text-secondary)]">
        <div className="text-[13px] font-medium text-[var(--app-text-primary)]">
          {concierge
            ? t("agentChatWelcomeConcierge", { engine: engineLabel })
            : t("agentChatWelcomeEngine", { engine: engineLabel })}
        </div>
        <p className="mt-0.5">
          {concierge ? t("agentChatWelcomeConciergeHint") : t("agentChatWelcomeEngineHint")}
        </p>
        {cwd ? (
          <p
            className="mt-1.5 flex items-center gap-1 font-mono text-[11px] text-[var(--app-text-tertiary)]"
            title={cwd}
          >
            <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {projectNameOf(cwd)} · {cwd}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
