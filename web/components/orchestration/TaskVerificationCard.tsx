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
    passed: t("verification.passed", { defaultValue: "通过 · 当前代码" }),
    failed: t("verification.failed", { defaultValue: "检查失败" }),
    timedOut: t("verification.timedOut", { defaultValue: "检查超时" }),
    stale: t("verification.stale", { defaultValue: "证据已过期 · 需要重跑" }),
    unknown: t("verification.unknown", { defaultValue: "代码状态未知 · 未验证" }),
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
        <span>{t("verification.exitCode", { defaultValue: "退出码" })}: {evidence.exitCode ?? "—"}</span>
        {evidence.signal !== null && <span>{t("verification.signal", { defaultValue: "终止信号" })}: {evidence.signal}</span>}
        <span>{t("verification.duration", { defaultValue: "耗时" })}: {(evidence.durationMs / 1000).toFixed(2)}s</span>
      </div>
      {evidence.codeChangedDuringRun && <p className="mt-2 text-amber-600">{t("verification.changedDuringRun", { defaultValue: "检查期间代码发生变化，此结果不能验证当前代码。" })}</p>}
      {(evidence.executionError || evidence.observationError) && <p className="mt-2 break-words text-destructive">{evidence.executionError || evidence.observationError}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground">{t("verification.details", { defaultValue: "执行详情与输出" })}</summary>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-all text-muted-foreground">
          <dt>{t("verification.cwd", { defaultValue: "工作目录" })}</dt><dd>{evidence.cwd}</dd>
          <dt>{t("verification.started", { defaultValue: "开始时间" })}</dt><dd>{new Date(evidence.startedAt).toLocaleString()}</dd>
          <dt>{t("verification.completed", { defaultValue: "结束时间" })}</dt><dd>{new Date(evidence.completedAt).toLocaleString()}</dd>
          <dt>{t("verification.head", { defaultValue: "原始 Git 提交" })}</dt><dd className="font-mono">{evidence.originalHead || "—"}</dd>
          <dt>{t("verification.fingerprint", { defaultValue: "原始代码指纹" })}</dt><dd className="font-mono">{evidence.originalFingerprint}</dd>
        </dl>
        {evidence.outputTruncated && <p className="mt-2 text-amber-600">{t("verification.truncated", { defaultValue: "输出已截断，每个输出流最多保留 64 KiB。" })}</p>}
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
    <section className="flex flex-col gap-3" aria-label={t("verification.title", { defaultValue: "验收证据" })}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("verification.title", { defaultValue: "验收证据" })}</h3>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {t("verification.refresh", { defaultValue: "刷新代码状态" })}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("verification.description", { defaultValue: "在任务项目目录运行你指定的检查命令。每次执行独立保存结果；代码变化后须重新检查。" })}</p>
      <form onSubmit={(event) => { event.preventDefault(); void run(); }} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
          {t("verification.command", { defaultValue: "检查命令" })}
          <input className="h-8 rounded-md border border-input bg-transparent px-2 font-mono" value={command}
            onChange={(event) => setCommand(event.target.value)} placeholder="npm test" maxLength={8192} disabled={busy} />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs">
          {t("verification.timeout", { defaultValue: "超时（秒）" })}
          <input type="number" min={1} max={600} required className="h-8 rounded-md border border-input bg-transparent px-2"
            value={timeoutSecs} onChange={(event) => setTimeoutSecs(Number(event.target.value))} disabled={busy} />
        </label>
        <Button type="submit" size="sm" disabled={!command.trim() || busy || report?.running || timeoutSecs < 1 || timeoutSecs > 600}>
          <Play className="h-3.5 w-3.5" />
          {busy || report?.running ? t("verification.running", { defaultValue: "检查运行中…" }) : t("verification.run", { defaultValue: "运行检查" })}
        </Button>
      </form>
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {report?.snapshotError && <p role="alert" className="break-words text-xs text-destructive">{report.snapshotError}</p>}
      {report?.evidence.length === 0 && <p className="text-xs text-muted-foreground">{t("verification.empty", { defaultValue: "尚无检查结果。任务完成不代表验收已通过。" })}</p>}
      {report?.evidence.map((item) => <Evidence key={item.id} evidence={item}
        currentFingerprint={report.currentFingerprint}
        checking={busy || refreshing || report.running || report.snapshotError !== null} />)}
    </section>
  );
}
