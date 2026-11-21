import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { AutomationDef, AutomationRun } from "@/types";
import { describeNextRun, describeSchedule, formatMillis } from "./automationDraft";

interface AutomationDetailProps {
  def: AutomationDef;
  engineLabel: string;
  workspaceName: string;
  runs: readonly AutomationRun[];
  onToggleEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const STATUS_TONE: Record<AutomationRun["status"], string> = {
  completed: "bg-[var(--app-status-success)]",
  failed: "bg-[var(--app-status-danger)]",
  skipped_missed: "bg-[var(--app-text-tertiary)]",
  skipped_overlap: "bg-[var(--app-text-tertiary)]",
};

/** 右栏详情：头部（日程/开关/操作）+ 对话气泡形式的 Prompt + 运行历史时间线。 */
export default function AutomationDetail({
  def,
  engineLabel,
  workspaceName,
  runs,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete,
}: AutomationDetailProps) {
  const { t, i18n } = useTranslation("settings");
  const locale = i18n.language;
  const [deleteArmed, setDeleteArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDeleteArmed(false);
    return () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, [def.id]);

  const handleDelete = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      armTimer.current = setTimeout(() => setDeleteArmed(false), 3000);
      return;
    }
    setDeleteArmed(false);
    onDelete();
  };

  return (
    <div data-testid="automation-detail" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--app-border)] py-4 pl-6 pr-14">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[1.125rem] font-semibold text-[var(--app-text-primary)]">{def.name}</h2>
          <p className="mt-0.5 truncate text-[length:var(--text-small)] text-[var(--app-text-secondary)]">
            {describeSchedule(def.schedule, t, locale)}
            {" · "}
            {def.enabled
              ? `${t("automations.nextRun")} ${describeNextRun(def.nextRunAt, t, locale)}`
              : t("automations.paused")}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[length:var(--text-small)] text-[var(--app-text-secondary)]">
          <Switch checked={def.enabled} onCheckedChange={onToggleEnabled} aria-label={t("automations.enabledLabel")} />
          {t("automations.enabledLabel")}
        </label>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={onRunNow}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {t("automations.runNow")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="mr-1 h-3.5 w-3.5" />
            {t("automations.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            className={deleteArmed ? "text-[var(--destructive)] hover:text-[var(--destructive)]" : undefined}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {deleteArmed ? t("automations.deleteConfirm") : t("automations.delete")}
          </Button>
        </div>
      </header>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <div className="flex flex-col items-end gap-2">
            <div
              data-testid="automation-prompt-bubble"
              className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--app-hover)] px-5 py-3.5 text-[length:var(--text-body)] leading-7 text-[var(--app-text-primary)]"
            >
              {def.prompt}
            </div>
            <div className="flex flex-wrap justify-end gap-1.5 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
              <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5">{engineLabel}</span>
              {workspaceName && (
                <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[var(--app-accent)]">{workspaceName}</span>
              )}
              <span className="flex max-w-[22rem] items-center gap-1 truncate rounded-full border border-[var(--app-border)] px-2 py-0.5" title={def.cwd}>
                <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{def.cwd || "—"}</span>
              </span>
            </div>
          </div>

          <section aria-label={t("automations.runs")}>
            <h3 className="mb-3 text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">{t("automations.runs")}</h3>
            {runs.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--app-border)] px-4 py-5 text-center text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                {t("automations.runsEmptyHint")}
              </p>
            ) : (
              <ol className="relative ml-1.5 border-l border-[var(--app-border)]">
                {runs.map((run) => (
                  <li key={run.id} className="relative pb-4 pl-5 last:pb-0">
                    <span aria-hidden="true" className={cn("absolute -left-[5px] top-1.5 size-2.5 rounded-full ring-4 ring-[var(--app-content)]", STATUS_TONE[run.status])} />
                    <div className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--text-small)]">
                      <span className={cn("font-medium", run.status === "failed" ? "text-[var(--app-status-danger)]" : "text-[var(--app-text-primary)]")}>
                        {t(`automations.status.${run.status}`)}
                      </span>
                      <span className="text-[var(--app-text-tertiary)]">{formatMillis(run.startedAt, locale)}</span>
                      {run.finishedAt != null && (
                        <span className="text-[var(--app-text-tertiary)]">
                          {t("automations.duration", { seconds: Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000)) })}
                        </span>
                      )}
                      {run.stopReason && <span className="text-[var(--app-text-secondary)]">{run.stopReason}</span>}
                    </div>
                    {run.detail && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[length:var(--text-small)] text-[var(--app-text-secondary)]">{run.detail}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
