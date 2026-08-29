// 终端叶子的异常态面板：恢复日志面（RestoreLogSurface）、恢复被阻断
// （BlockedRestorePanel）、启动失败（LaunchErrorPanel）。
// 从 TerminalTabContent.tsx 抽出（行数棘轮）：三者只消费 leaf 级数据，
// 与 pane 树渲染无耦合。
import { useMemo, useState } from "react";
import { CircleAlert, RotateCcw, Terminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TerminalLaunchError, TerminalPaneNode } from "@/types";
import type { TerminalRestoreLogEntry } from "@/stores/useTerminalRestoreLogStore";
import { coldRestoreBlockedTerminal } from "@/hooks/coldTerminalRestore";
import { useManualAdopt } from "@/hooks/manualSessionAdopt";
import { Button } from "@/components/ui/button";
import { translateError } from "@/utils";
import { formatRestoreLogEntry, restoreLogToneColor } from "./terminalRestoreLogFormat";

export function RestoreLogSurface({ entries }: { entries: TerminalRestoreLogEntry[] }) {
  const { t } = useTranslation("panes");
  const [showRaw, setShowRaw] = useState(false);
  const formatted = useMemo(
    () => entries.map((entry) => ({ id: entry.id, ...formatRestoreLogEntry(entry, t) })),
    [entries, t],
  );
  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden border-t border-[var(--app-border)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-foreground">{t("restoreLogTitle")}</span>
        <button
          type="button"
          aria-pressed={showRaw}
          onClick={() => setShowRaw((value) => !value)}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-4 hover:bg-[var(--app-hover)]"
          style={{ color: showRaw ? "var(--app-text-primary)" : "var(--app-text-tertiary)" }}
        >
          {t("restoreLogDetails")}
        </button>
      </div>
      <div
        role="log"
        aria-live="polite"
        className="max-h-52 overflow-y-auto border-t border-[var(--app-border)] px-3 py-2 text-[11px] leading-4 text-muted-foreground"
      >
        {formatted.length > 0
          ? formatted.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2">
                <span
                  className="shrink-0 font-mono tabular-nums"
                  style={{ color: "var(--app-text-tertiary)" }}
                >
                  {entry.time}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="break-words whitespace-pre-wrap"
                    style={{ color: restoreLogToneColor(entry.tone) }}
                  >
                    {entry.text}
                  </div>
                  {showRaw ? (
                    <div
                      className="break-all whitespace-pre-wrap font-mono"
                      style={{ color: "var(--app-text-tertiary)" }}
                    >
                      {entry.raw}
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          : t("restoreLogPending")}
      </div>
    </div>
  );
}

export function BlockedRestorePanel({
  tabId,
  terminalPaneId,
  leaf,
  reason,
  entries,
}: {
  tabId: string;
  terminalPaneId: string;
  leaf: Extract<TerminalPaneNode, { type: "leaf" }>;
  reason: NonNullable<Extract<TerminalPaneNode, { type: "leaf" }>["restoreBlockedReason"]>;
  entries: TerminalRestoreLogEntry[];
}) {
  const { t } = useTranslation("panes");
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const canColdRestore = reason === "claims-unsupported"
    && Boolean(leaf.savedSessionId);
  // 旧实现只有 claims-unsupported 有按钮，其余阻断原因一律是死面板。
  const manualAdopt = useManualAdopt(reason, leaf.restoreBlockedSessionId, !canColdRestore);

  const handleColdRestore = async () => {
    if (!canColdRestore || running) return;
    setFailed(false);
    setRunning(true);
    try {
      await coldRestoreBlockedTerminal(tabId, terminalPaneId);
    } catch {
      setFailed(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background/95 px-6 py-8">
      <div className="flex w-full max-w-3xl flex-col items-center text-center">
        <CircleAlert className="mb-4 h-9 w-9 text-[var(--app-status-warning)]" aria-hidden="true" />
        <h3 className="text-base font-semibold text-foreground">
          {canColdRestore ? t("coldRestoreTitle") : t("restoreBlockedTitle")}
        </h3>
        <p className="mt-2 max-w-full break-words text-sm leading-6 text-muted-foreground">
          {canColdRestore ? t("coldRestoreHint") : t(`restoreBlocked.${reason}`)}
        </p>
        {canColdRestore ? (
          <div className="mt-5 flex flex-col items-center gap-2">
            <Button size="sm" onClick={() => void handleColdRestore()} disabled={running}>
              <RotateCcw className="h-4 w-4" />
              {running ? t("coldRestoreRunning") : t("coldRestoreAction")}
            </Button>
            {failed ? (
              <p className="max-w-xl text-xs leading-5 text-destructive" role="alert">
                {t("coldRestoreFailed")}
              </p>
            ) : null}
          </div>
        ) : null}
        {manualAdopt.available ? (
          <div className="mt-5 flex flex-col items-center gap-2">
            <Button size="sm" onClick={() => void manualAdopt.adopt()} disabled={manualAdopt.running}>
              <RotateCcw className="h-4 w-4" />
              {manualAdopt.running ? t("manualAdopt.running") : t("manualAdopt.action")}
            </Button>
            {manualAdopt.error ? (
              <p className="max-w-xl text-xs leading-5 text-destructive" role="alert">
                {manualAdopt.error}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-5 w-full text-left">
          <RestoreLogSurface entries={entries} />
        </div>
      </div>
    </div>
  );
}

export function LaunchErrorPanel({
  error,
  onRetry,
  onRemove,
}: {
  error: TerminalLaunchError;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("panes");
  const message = translateError(error);
  return (
    <div className="flex h-full w-full items-center justify-center bg-background/95 px-6 py-8">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <CircleAlert className="mb-4 h-9 w-9 text-destructive" aria-hidden="true" />
        <h3 className="text-base font-semibold text-foreground">{t("terminalLaunchFailed")}</h3>
        <p className="mt-2 max-w-full break-words text-sm leading-6 text-muted-foreground">
          {message}
        </p>
        {error.params?.path ? (
          <code className="mt-2 max-w-full break-all text-xs text-muted-foreground">
            {error.params.path}
          </code>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={onRetry}>
            <RotateCcw className="h-4 w-4" />
            {t("retryTerminalLaunch")}
          </Button>
          <Button size="sm" variant="outline" onClick={onRemove}>
            <X className="h-4 w-4" />
            {t("removeFailedTerminal")}
          </Button>
        </div>
      </div>
    </div>
  );
}
