import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Trash2, Loader2, CheckCircle, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { claudeService, type BrokenSession, type CleanResult } from "@/services/claudeService";
import { formatSize, getFileName, handleErrorSilent } from "@/utils";

interface SessionCleanerPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath?: string;
}

export default function SessionCleanerPanel({ open, onOpenChange, projectPath }: SessionCleanerPanelProps) {
  const { t } = useTranslation("dialogs");
  const [sessions, setSessions] = useState<BrokenSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResults, setCleanResults] = useState<CleanResult[]>([]);

  const panelTitle = useMemo(() => {
    if (projectPath) {
      const name = projectPath.replace(/\\/g, "/").split("/").pop() || projectPath;
      return t("sessionCleanerTitleWithName", { name });
    }
    return t("sessionCleanerTitle");
  }, [projectPath, t]);

  useEffect(() => {
    if (open) loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadSessions() {
    setLoading(true);
    setCleanResults([]);
    try {
      setSessions(await claudeService.scanBrokenSessions(projectPath || undefined));
    } catch (e) {
      handleErrorSilent(e, "scan broken sessions");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }

  async function cleanOne(session: BrokenSession) {
    setCleaning(true);
    try {
      const result = await claudeService.cleanSessionFile(session.file_path);
      setCleanResults([result]);
      await loadSessions();
    } catch (e) {
      handleErrorSilent(e, "clean session");
      setCleanResults([{ file_path: session.file_path, removed_blocks: 0, success: false, error: String(e) }]);
    } finally {
      setCleaning(false);
    }
  }

  async function cleanAll() {
    setCleaning(true);
    try {
      setCleanResults(await claudeService.cleanAllBrokenSessions(projectPath || undefined));
      await loadSessions();
    } catch (e) {
      handleErrorSilent(e, "clean all sessions");
      setCleanResults([]);
    } finally {
      setCleaning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent resizable className="w-[48rem] h-[80vh] max-w-[95vw] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck size={18} />
            {panelTitle}
          </DialogTitle>
        </DialogHeader>

        <p
          className="text-[13px] leading-relaxed m-0 mb-3 [&_code]:px-1 [&_code]:py-px [&_code]:rounded [&_code]:text-xs"
          style={{ color: "var(--app-text-secondary)" }}
          dangerouslySetInnerHTML={{ __html: t("sessionCleanerDesc") }}
        />

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: "var(--app-text-tertiary)" }}>
            <Loader2 size={20} className="animate-spin" />
            <span>{t("sessionCleanerScanning")}</span>
          </div>
        ) : (
          <>
            {sessions.length === 0 && cleanResults.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: "var(--app-accent)" }}>
                <CheckCircle size={20} />
                <span>{t("sessionCleanerNoIssues")}</span>
              </div>
            )}

            {sessions.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
                  <span>{t("sessionCleanerFound", { count: sessions.length })}</span>
                  <Button size="sm" variant="destructive" disabled={cleaning} onClick={cleanAll}>
                    {cleaning ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Trash2 size={14} className="mr-1" />}
                    {t("sessionCleanerCleanAll")}
                  </Button>
                </div>

                <div className="rounded-lg max-h-[320px] overflow-y-auto" style={{ border: "1px solid var(--app-border)" }}>
                  {sessions.map((session) => (
                    <div
                      key={session.file_path}
                      className="flex justify-between items-center px-3 py-2.5 transition-colors hover:bg-[var(--app-hover)]"
                      style={{ borderBottom: "1px solid var(--app-border)" }}
                    >
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-[13px] font-medium truncate" style={{ color: "var(--app-text-primary)" }}>
                          {getFileName(session.file_path)}
                        </span>
                        <span className="text-[11px] truncate" style={{ color: "var(--app-text-tertiary)" }}>
                          {session.project_path}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="secondary">{t("sessionCleanerBlocks", { count: session.thinking_blocks })}</Badge>
                        <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{formatSize(session.file_size)}</span>
                        <Button size="sm" variant="outline" disabled={cleaning} onClick={() => cleanOne(session)}>
                          {t("sessionCleanerClean")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cleanResults.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-3">
                <div className="text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("sessionCleanerResults")}</div>
                {cleanResults.map((result) => (
                  <div
                    key={result.file_path}
                    className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px]"
                    style={{
                      background: result.success ? "hsl(142 76% 36% / 0.1)" : "hsl(0 84% 60% / 0.1)",
                      color: result.success ? "hsl(142 76% 36%)" : "hsl(0 84% 60%)",
                    }}
                  >
                    {result.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                    <span className="font-medium">{getFileName(result.file_path)}</span>
                    <span className="ml-auto text-xs">
                      {result.success ? t("sessionCleanerRemoved", { count: result.removed_blocks }) : result.error}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
