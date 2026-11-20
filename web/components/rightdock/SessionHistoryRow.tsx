// 右侧「终端会话」列表的一行。悬浮时在左侧弹出这段会话的详情（首条输入、最近进展）。
// 配色分主次：标题主色，下面一行进展次色，元信息三级色；「恢复」平时收着，悬浮到行上才亮。
import { HoverCard } from "radix-ui";
import { useTranslation } from "react-i18next";
import { AlertTriangle, LoaderCircle, Play } from "lucide-react";
import SessionEntryDetail from "@/components/sessions/SessionEntryDetail";
import { readableLine, sessionEntryTitle } from "@/components/sessions/sessionEntryText";
import type { SessionIndexEntry } from "@/types/sessionIndex";

interface SessionHistoryRowProps {
  entry: SessionIndexEntry;
  invalid: boolean;
  checking: boolean;
  relativeTime: string;
  fullTime: string;
  onResume: (entry: SessionIndexEntry) => void;
}

export default function SessionHistoryRow({ entry, invalid, checking, relativeTime, fullTime, onResume }: SessionHistoryRowProps) {
  const { t } = useTranslation("sidebar");
  const title = sessionEntryTitle(entry) || t("sessionHistory.untitled");
  const progress = readableLine(entry.lastSummary);
  return (
    <HoverCard.Root openDelay={450} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <article className="group px-3 py-3 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[length:var(--text-small)] font-medium leading-5 text-[var(--app-text-primary)]">
                {title}
              </p>
              {progress && progress !== title && (
                <p className="mt-0.5 truncate text-[length:var(--text-caption)] leading-5 text-[var(--app-text-secondary)]">{progress}</p>
              )}
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
                <span className="rounded bg-[color-mix(in_srgb,var(--app-accent)_14%,transparent)] px-1.5 py-0.5 font-medium capitalize text-[var(--app-accent)]">
                  {entry.cliTool}
                </span>
                <span>{t("sessionHistory.messages", { count: entry.messageCount })}</span>
                <span aria-hidden="true">·</span>
                <time title={fullTime}>{relativeTime}</time>
                <span aria-hidden="true">·</span>
                <span className="max-w-full truncate" title={entry.projectName}>
                  {entry.projectName || t("sessionHistory.unknownProject")}
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={invalid || checking}
              aria-busy={checking}
              onClick={() => onResume(entry)}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[length:var(--text-caption)] font-medium text-[var(--app-text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-accent)] hover:text-[var(--primary-foreground)] focus-visible:text-[var(--app-text-primary)] group-hover:bg-[var(--app-active-bg)] group-hover:text-[var(--app-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checking
                ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
                : <Play aria-hidden="true" className="size-3" />}
              <span>{t("sessionHistory.resume")}</span>
            </button>
          </div>
          {invalid && (
            <p role="alert" className="mt-1.5 flex items-center gap-1 text-[length:var(--text-micro)] text-[var(--app-status-warning)]">
              <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
              <span>{t("sessionHistory.rolloutMissing")}</span>
            </p>
          )}
        </article>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          data-testid="session-history-hover-card"
          className="z-50 max-h-[min(520px,80vh)] w-[340px] overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3.5 shadow-[var(--sh-lg)]"
        >
          <SessionEntryDetail entry={entry} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
