import { useEffect, useRef, useState } from "react";
import "@/i18n/taskVerificationResources";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { taskVerificationService } from "@/services/taskVerificationService";
import type { TaskCompletionReport, TaskVerificationReport } from "@/types/taskVerification";

interface Props {
  taskId: string;
  completion: TaskCompletionReport;
  checking: boolean;
  onReport: (report: TaskVerificationReport) => void;
  onRun: (command: string) => void;
}

export default function TaskCompletionCard({ taskId, completion, checking, onReport, onRun }: Props) {
  const { t } = useTranslation("orchestration");
  const [definition, setDefinition] = useState(completion.criteria.definitionOfDone);
  const [commands, setCommands] = useState(completion.criteria.requiredCommands.join("\n"));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTask = useRef(taskId);
  activeTask.current = taskId;
  useEffect(() => () => { activeTask.current = ""; }, []);
  useEffect(() => {
    setDefinition(completion.criteria.definitionOfDone);
    setCommands(completion.criteria.requiredCommands.join("\n"));
    setError(null);
  }, [completion.criteriaRevision, completion.criteria.definitionOfDone, completion.criteria.requiredCommands.join("\n")]);

  const mutate = async (action: () => Promise<TaskVerificationReport>) => {
    setBusy(true); setError(null);
    try {
      const next = await action();
      if (activeTask.current === taskId) onReport(next);
    } catch (failure) {
      if (activeTask.current === taskId) {
        setError(typeof failure === "object" && failure !== null && "message" in failure
          ? String(failure.message) : String(failure));
      }
    } finally {
      if (activeTask.current === taskId) setBusy(false);
    }
  };
  const disabled = checking || busy;
  const accepted = completion.userAccepted && !disabled && !error;
  const passed = completion.checksStatus === "passed" && !disabled && !error;
  const dirty = definition.trim() !== completion.criteria.definitionOfDone
    || commands.split("\n").map((line) => line.trim()).filter(Boolean).join("\n") !== completion.criteria.requiredCommands.join("\n");

  return (
    <section className="rounded-lg border border-border bg-muted/20 p-3 text-xs" aria-label={t("completion.title")}>
      <h3 className="font-semibold">{t("completion.title")}</h3>
      <ol className="my-3 flex flex-wrap gap-x-5 gap-y-2" aria-label={t("completion.stages")}>
        <li>{completion.agentFinished ? "✓ " : "○ "}{t("completion.agentFinished")}</li>
        <li className={passed ? "text-[var(--app-status-success)]" : "text-muted-foreground"}>
          {passed ? "✓ " : "○ "}{t("completion.checksPassed")}: {t(`completion.status.${disabled ? "unknown" : completion.checksStatus}`)}
        </li>
        <li className={accepted ? "text-[var(--app-status-success)]" : "text-muted-foreground"}>
          {accepted ? "✓ " : "○ "}{t("completion.userAccepted")}
        </li>
      </ol>
      {completion.acceptance && !accepted && !disabled && <p className="mb-2 text-[var(--app-status-warning)]">{t("completion.acceptanceStale")}</p>}
      {accepted && <p className="mb-2 text-muted-foreground">{new Date(completion.acceptance!.acceptedAt).toLocaleString()} {completion.acceptance!.note}</p>}
      <details className="mb-3" open={completion.criteria.requiredCommands.length === 0}>
        <summary className="cursor-pointer">{t("completion.criteria")}</summary>
        <label className="mt-2 flex flex-col gap-1">{t("completion.definition")}
          <textarea className="min-h-16 rounded-md border border-input bg-transparent p-2" value={definition}
            onChange={(event) => setDefinition(event.target.value)} maxLength={8192} disabled={disabled} />
        </label>
        <label className="mt-2 flex flex-col gap-1">{t("completion.requiredCommands")}
          <textarea className="min-h-16 rounded-md border border-input bg-transparent p-2 font-mono" value={commands}
            onChange={(event) => setCommands(event.target.value)} maxLength={32768} disabled={disabled} placeholder="npm test" />
        </label>
        <p className="my-2 text-muted-foreground">{t("completion.criteriaHelp")}</p>
        <Button size="sm" variant="outline" disabled={disabled || !dirty} onClick={() => void mutate(() => taskVerificationService.setCriteria(taskId, {
          expectedRevision: completion.criteriaRevision,
          criteria: { definitionOfDone: definition, requiredCommands: commands.split("\n").map((line) => line.trim()).filter(Boolean) },
        }))}>{t("completion.saveCriteria")}</Button>
      </details>
      {completion.checks.map((check) => <div key={check.command} className="my-2 flex items-center justify-between gap-2">
        <span className="min-w-0 break-all"><code>{check.command}</code> · {t(`completion.status.${disabled ? "unknown" : check.status}`)}</span>
        <Button size="sm" variant="outline" disabled={disabled || dirty} onClick={() => onRun(check.command)}>{t("completion.runRequired")}</Button>
      </div>)}
      {completion.checks.length === 0 && <p className="mb-2 text-muted-foreground">{t("completion.manualHelp")}</p>}
      {!accepted && <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex min-w-40 flex-1 flex-col gap-1">{t("completion.note")}
          <input className="h-8 rounded-md border border-input bg-transparent px-2" value={note} maxLength={8192}
            onChange={(event) => setNote(event.target.value)} disabled={disabled} />
        </label>
        <Button size="sm" disabled={disabled || dirty || !completion.canAccept} onClick={() => void mutate(() => taskVerificationService.accept(taskId, {
          expectedCriteriaRevision: completion.criteriaRevision, expectedReportRevision: completion.reportRevision,
          expectedFingerprint: completion.codeFingerprint, expectedEvidenceIds: completion.checks.flatMap((check) => check.evidenceId ? [check.evidenceId] : []), note,
        }))}>{t("completion.accept")}</Button>
      </div>}
      {(dirty || (!accepted && !completion.canAccept)) && <p className="mt-2 text-muted-foreground">{t(dirty ? "completion.unsaved" : "completion.blocked")}</p>}
      {error && <p role="alert" className="mt-2 break-words text-destructive">{error}</p>}
    </section>
  );
}
