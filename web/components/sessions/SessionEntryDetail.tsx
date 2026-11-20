// 一条终端会话的详情：这段会话是什么、聊到哪了。
// 搜索面板的右侧预览和右侧「终端会话」列表的悬浮卡片共用。
// 配色分三层：标题用主色，正文用次色，标签和元信息用三级色。
import { useTranslation } from "react-i18next";
import type { SessionIndexEntry } from "@/types/sessionIndex";
import { formatRelativeTime } from "@/utils";
import { sessionEntryTitle } from "./sessionEntryText";

const LABEL_CLASS = "mb-1 text-[length:var(--text-micro)] font-medium text-[var(--app-text-tertiary)]";
const BODY_CLASS = "whitespace-pre-wrap break-words text-[length:var(--text-caption)] leading-relaxed text-[var(--app-text-secondary)]";

export default function SessionEntryDetail({ entry }: { entry: SessionIndexEntry }) {
  const { t } = useTranslation(["shortcuts", "sidebar"]);
  const firstPrompt = entry.firstPrompt.trim();
  const summary = entry.lastSummary.trim();
  const meta = [
    entry.mtimeMs > 0 ? formatRelativeTime(new Date(entry.mtimeMs).toISOString()) : "",
    entry.messageCount > 0 ? t("palettePreviewMessages", { ns: "shortcuts", count: entry.messageCount }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-2.5" data-testid="session-entry-detail">
      <div className="text-[length:var(--text-row)] font-semibold leading-snug text-[var(--app-text-primary)] line-clamp-3">
        {sessionEntryTitle(entry) || t("sessionHistory.untitled", { ns: "sidebar" })}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
        <span className="rounded bg-[color-mix(in_srgb,var(--app-accent)_14%,transparent)] px-1.5 py-0.5 font-medium capitalize text-[var(--app-accent)]">
          {entry.cliTool}
        </span>
        <span>{meta}</span>
      </div>
      <div className="break-all font-mono text-[length:var(--text-nano)] text-[var(--app-text-tertiary)]">{entry.cwd}</div>
      {firstPrompt && (
        <section>
          <div className={LABEL_CLASS}>{t("palettePreviewFirstPrompt", { ns: "shortcuts" })}</div>
          <p className={`${BODY_CLASS} line-clamp-6`}>{firstPrompt}</p>
        </section>
      )}
      {summary && (
        <section>
          <div className={LABEL_CLASS}>{t("palettePreviewSummary", { ns: "shortcuts" })}</div>
          <p className={`${BODY_CLASS} line-clamp-[10]`}>{summary}</p>
        </section>
      )}
      {!firstPrompt && !summary && (
        <p className="text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t("palettePreviewNoContent", { ns: "shortcuts" })}</p>
      )}
    </div>
  );
}
