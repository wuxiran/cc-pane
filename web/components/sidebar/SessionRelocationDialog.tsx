// 项目目录移动 / 改名后迁移历史会话（docs/115 §2）：先预览（dry-run）看数量，确认后再迁移。
// 状态来自 useDialogStore，由 AppDialogs 挂载；入口在项目右键菜单。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDirectoryPicker } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { sessionRelocationService } from "@/services/sessionRelocationService";
import { useDialogStore } from "@/stores";
import type { SessionRelocationReport } from "@/types/sessionRelocation";
import { getErrorMessage } from "@/utils";

type Phase = "idle" | "previewing" | "migrating";

function PathField({ id, label, value, onChange, pickTitle }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  pickTitle: string;
}) {
  const pick = async () => {
    const selected = await openDirectoryPicker({ directory: true, multiple: false, title: pickTitle });
    if (typeof selected === "string") onChange(selected);
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-[var(--app-text-secondary)]">{label}</label>
      <div className="flex gap-2">
        <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="icon" aria-label={pickTitle} onClick={() => void pick().catch(() => {})}>
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ReportView({ report }: { report: SessionRelocationReport }) {
  const { t } = useTranslation("dialogs");
  const rows: [string, number][] = [
    [t("sessionRelocation.claudeSessions"), report.claudeSessions],
    [t("sessionRelocation.codexSessions"), report.codexSessions],
    [t("sessionRelocation.launchHistoryRows"), report.launchHistoryRows],
    [t("sessionRelocation.taskBindingRows"), report.taskBindingRows],
  ];
  return (
    <div className="space-y-2 rounded-lg border border-[var(--app-border)] p-3 text-xs text-[var(--app-text-secondary)]" data-testid="session-relocation-report">
      <div className="font-medium text-[var(--app-text-primary)]">
        {report.dryRun ? t("sessionRelocation.previewTitle") : t("sessionRelocation.doneTitle")}
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows.map(([label, count]) => (
          <div key={label} className="contents"><dt>{label}</dt><dd className="text-right tabular-nums text-[var(--app-text-primary)]">{count}</dd></div>
        ))}
      </dl>
      {report.skipped.length > 0 && (
        <div>
          <div className="text-[var(--app-status-warning)]">{t("sessionRelocation.skipped", { count: report.skipped.length })}</div>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
            {report.skipped.map((item) => (
              <li key={`${item.cli}:${item.sessionId}`}>
                {item.cli} · {item.sessionId} · {t(`sessionRelocation.reason.${item.reason}`, { defaultValue: item.reason })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.map((warning) => <div key={warning} className="text-[var(--app-text-tertiary)]">{warning}</div>)}
      {report.backupDir && (
        <div className="break-all text-[var(--app-text-tertiary)]">{t("sessionRelocation.backup", { path: report.backupDir })}</div>
      )}
    </div>
  );
}

export default function SessionRelocationDialog() {
  const { t } = useTranslation(["dialogs", "common"]);
  const open = useDialogStore((s) => s.sessionRelocationOpen);
  const initialOld = useDialogStore((s) => s.sessionRelocationOldPath);
  const initialNew = useDialogStore((s) => s.sessionRelocationNewPath);
  const [oldPath, setOldPath] = useState("");
  const [newPath, setNewPath] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<SessionRelocationReport | null>(null);
  const [previewKey, setPreviewKey] = useState("");

  useEffect(() => {
    if (!open) return;
    setOldPath(initialOld);
    setNewPath(initialNew);
    setReport(null);
    setPreviewKey("");
  }, [open, initialOld, initialNew]);

  const key = useMemo(() => JSON.stringify([oldPath.trim(), newPath.trim()]), [oldPath, newPath]);
  const ready = oldPath.trim() !== "" && newPath.trim() !== "";
  const total = report?.dryRun ? report.claudeSessions + report.codexSessions + report.launchHistoryRows + report.taskBindingRows : 0;
  const canMigrate = phase === "idle" && report?.dryRun === true && previewKey === key && total > 0;

  const run = async (dryRun: boolean) => {
    setPhase(dryRun ? "previewing" : "migrating");
    try {
      const result = await sessionRelocationService.relocate({ oldPath: oldPath.trim(), newPath: newPath.trim(), dryRun });
      setReport(result);
      setPreviewKey(dryRun ? key : "");
      if (!dryRun) toast.success(t("sessionRelocation.done", { count: result.claudeSessions + result.codexSessions }));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setPhase("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) useDialogStore.getState().closeSessionRelocation(); }}>
      <DialogContent className="max-w-xl" data-testid="session-relocation-dialog">
        <DialogHeader>
          <DialogTitle>{t("sessionRelocation.title")}</DialogTitle>
          <DialogDescription>{t("sessionRelocation.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <PathField id="session-relocation-old" label={t("sessionRelocation.oldPath")} value={oldPath} onChange={setOldPath} pickTitle={t("sessionRelocation.pickOld")} />
          <PathField id="session-relocation-new" label={t("sessionRelocation.newPath")} value={newPath} onChange={setNewPath} pickTitle={t("sessionRelocation.pickNew")} />
          <p className="text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("sessionRelocation.safetyHint")}</p>
          {report && <ReportView report={report} />}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => useDialogStore.getState().closeSessionRelocation()}>
            {t("common:close")}
          </Button>
          <Button type="button" variant="outline" disabled={!ready || phase !== "idle"} onClick={() => void run(true)} data-testid="session-relocation-preview">
            {phase === "previewing" && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("sessionRelocation.preview")}
          </Button>
          <Button type="button" disabled={!canMigrate} onClick={() => void run(false)} data-testid="session-relocation-execute">
            {phase === "migrating" && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("sessionRelocation.execute")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
