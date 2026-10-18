import "@/i18n/taskVerificationResources";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { taskVerificationService } from "@/services/taskVerificationService";
import type { TaskVerificationEvidence, TaskVerificationReport } from "@/types/taskVerification";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

function Evidence({ evidence, currentFingerprint, checking }: {
  evidence: TaskVerificationEvidence;
  currentFingerprint: string | null;
  checking: boolean;
}) {
  const { t } = useTranslation("orchestration");
  const codeMatches = evidence.freshness === "current" && currentFingerprint !== null
    && evidence.originalFingerprint === currentFingerprint
    && evidence.finalFingerprint === currentFingerprint;
  const passed = evidence.exitCode === 0 && evidence.signal === null
    && !evidence.timedOut && evidence.executionError === null;
  const status = evidence.codeChangedDuringRun || evidence.freshness === "stale" ? "stale"
    : checking || evidence.observationError !== null || !codeMatches ? "unknown"
    : evidence.timedOut ? "timedOut" : passed ? "passed" : "failed";
  const labels = {
    passed: t("verification.passed", { defaultValue: "Passed · current code" }),
    failed: t("verification.failed", { defaultValue: "Check failed" }),
    timedOut: t("verification.timedOut", { defaultValue: "Check timed out" }),
    stale: t("verification.stale", { defaultValue: "Evidence is outdated · rerun required" }),
    unknown: t("verification.unknown", { defaultValue: "Code state unknown · unverified" }),
  };
  return (
    <article className="rounded-md border border-border p-3 text-xs" aria-label={evidence.command}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="break-all font-medium">{evidence.command}</code>
        <span className={status === "passed" ? "text-[var(--app-status-success)]" : "text-muted-foreground"}>
          {labels[status]}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{t("verification.exitCode", { defaultValue: "Exit code" })}: {evidence.exitCode ?? "—"}</span>
        {evidence.signal !== null && <span>{t("verification.signal", { defaultValue: "Termination signal" })}: {evidence.signal}</span>}
        <span>{t("verification.duration", { defaultValue: "Duration" })}: {(evidence.durationMs / 1000).toFixed(2)}s</span>
      </div>
      {evidence.codeChangedDuringRun && <p className="mt-2 text-[var(--app-status-warning)]">{t("verification.changedDuringRun", { defaultValue: "Code changed during this check; this result cannot verify the current code." })}</p>}
      {(evidence.executionError || evidence.observationError) && <p className="mt-2 break-words text-destructive">{evidence.executionError || evidence.observationError}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground">{t("verification.details", { defaultValue: "Execution details and output" })}</summary>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-all text-muted-foreground">
          <dt>{t("verification.cwd", { defaultValue: "Working directory" })}</dt><dd>{evidence.cwd}</dd>
          <dt>{t("verification.started", { defaultValue: "Started" })}</dt><dd>{new Date(evidence.startedAt).toLocaleString()}</dd>
          <dt>{t("verification.completed", { defaultValue: "Completed" })}</dt><dd>{new Date(evidence.completedAt).toLocaleString()}</dd>
          <dt>{t("verification.head", { defaultValue: "Original Git commit" })}</dt><dd className="font-mono">{evidence.originalHead || "—"}</dd>
          <dt>{t("verification.fingerprint", { defaultValue: "Original code fingerprint" })}</dt><dd className="font-mono">{evidence.originalFingerprint}</dd>
        </dl>
        {evidence.outputTruncated && <p className="mt-2 text-[var(--app-status-warning)]">{t("verification.truncated", { defaultValue: "Output truncated; each stream retains at most 64 KiB." })}</p>}
        <p className="mt-2 font-medium">stdout</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2">{evidence.stdout || "—"}</pre>
        <p className="mt-2 font-medium">stderr</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2">{evidence.stderr || "—"}</pre>
      </details>
    </article>
  );
}

export default function TaskVerificationCard({ taskId }: { taskId: string }) {
  const { t } = useTranslation("orchestration");
  const [report, setReport] = useState<TaskVerificationReport | null>(null);
  const [command, setCommand] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(300);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTask = useRef(taskId);
  const sequence = useRef(0);
  activeTask.current = taskId;

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setRefreshing(true);
    try {
      const next = await taskVerificationService.list(taskId);
      if (activeTask.current === taskId && request === sequence.current) {
        setReport(next); setError(null);
      }
    } catch (failure) {
      if (activeTask.current === taskId && request === sequence.current) {
        setError(errorMessage(failure));
        setReport((previous) => previous ? { ...previous, currentFingerprint: null,
          evidence: previous.evidence.map((item) => ({ ...item, freshness: "unknown" })) } : null);
      }
    } finally {
      if (activeTask.current === taskId && request === sequence.current) setRefreshing(false);
    }
  }, [taskId]);

  useEffect(() => {
    activeTask.current = taskId;
    setReport(null); setError(null); setBusy(false); setCommand("");
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 10000);
    return () => {
      if (activeTask.current === taskId) activeTask.current = "";
      sequence.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, taskId]);

  const run = async () => {
    if (!command.trim() || busy || report?.running) return;
    setBusy(true); setError(null);
    ++sequence.current;
    try {
      const next = await taskVerificationService.run(taskId, { command, timeoutSecs });
      if (activeTask.current === taskId) { ++sequence.current; setReport(next); }
    } catch (failure) {
      if (activeTask.current === taskId) setError(errorMessage(failure));
    } finally {
      if (activeTask.current === taskId) { setBusy(false); setRefreshing(false); void refresh(); }
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t("verification.title", { defaultValue: "Verification evidence" })}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("verification.title", { defaultValue: "Verification evidence" })}</h3>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {t("verification.refresh", { defaultValue: "Refresh code state" })}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("verification.description", { defaultValue: "Run your check command in this task’s project directory. Each execution is saved separately; changed code requires a new check." })}</p>
      <form onSubmit={(event) => { event.preventDefault(); void run(); }} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
          {t("verification.command", { defaultValue: "Check command" })}
          <input className="h-8 rounded-md border border-input bg-transparent px-2 font-mono" value={command}
            onChange={(event) => setCommand(event.target.value)} placeholder="npm test" maxLength={8192} disabled={busy} />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs">
          {t("verification.timeout", { defaultValue: "Timeout (seconds)" })}
          <input type="number" min={1} max={600} required className="h-8 rounded-md border border-input bg-transparent px-2"
            value={timeoutSecs} onChange={(event) => setTimeoutSecs(Number(event.target.value))} disabled={busy} />
        </label>
        <Button type="submit" size="sm" disabled={!command.trim() || busy || report?.running || timeoutSecs < 1 || timeoutSecs > 600}>
          <Play className="h-3.5 w-3.5" />
          {busy || report?.running ? t("verification.running", { defaultValue: "Check running…" }) : t("verification.run", { defaultValue: "Run check" })}
        </Button>
      </form>
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {report?.snapshotError && <p role="alert" className="break-words text-xs text-destructive">{report.snapshotError}</p>}
      {report?.evidence.length === 0 && <p className="text-xs text-muted-foreground">{t("verification.empty", { defaultValue: "No check results yet. Task completion does not mean verification passed." })}</p>}
      {report?.evidence.map((item) => <Evidence key={item.id} evidence={item}
        currentFingerprint={report.currentFingerprint}
        checking={busy || refreshing || report.running || report.snapshotError !== null} />)}
    </section>
  );
}
