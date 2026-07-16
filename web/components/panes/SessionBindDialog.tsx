import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { claudeService, codexService, historyService } from "@/services";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";

interface SessionCandidate {
  id: string;
  description: string;
  modifiedAt: number;
}

interface SessionBindDialogProps {
  tab: Tab | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 会话绑定面板：列出该 tab 项目的历史会话，让用户手动选择/换绑 resume id。
 * 「人选」替代旧 backfill 的「机器猜」，绑定写入 tab（随 zustand persist 持久化，
 * 重启恢复即以此为准）。
 */
export default function SessionBindDialog({ tab, open, onOpenChange }: SessionBindDialogProps) {
  const { t } = useTranslation("panes");
  const [candidates, setCandidates] = useState<SessionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const setTabResumeBinding = usePanesStore((s) => s.setTabResumeBinding);

  const loadCandidates = useCallback(async (target: Tab) => {
    setLoading(true);
    setLoadError(null);
    try {
      const projectPath = target.workspacePath || target.projectPath;
      if (target.cliTool === "codex") {
        const runtimeKind = target.wsl ? "wsl" : "local";
        const sessions = await codexService.listSessions(projectPath, runtimeKind, target.wsl?.distro);
        setCandidates(
          sessions.map((s) => ({ id: s.id, description: s.description, modifiedAt: s.modified_at })),
        );
      } else {
        const sessions = await claudeService.listSessions(projectPath);
        setCandidates(
          sessions.map((s) => ({ id: s.id, description: s.description, modifiedAt: s.modified_at })),
        );
      }
    } catch (err) {
      setCandidates([]);
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab) {
      setManualId("");
      void loadCandidates(tab);
    }
  }, [open, tab, loadCandidates]);

  if (!tab) return null;

  const bind = (resumeId: string) => {
    setTabResumeBinding(tab.id, resumeId, "manual");
    // 同步回写 launch_history（有匹配记录时），避免历史列表与绑定状态分叉
    historyService
      .touchBySessionId(resumeId)
      .then((recordId) => {
        if (recordId !== null) {
          return historyService.updateResumeSource(recordId, "manual");
        }
      })
      .catch(console.error);
    onOpenChange(false);
  };

  const unbind = () => {
    setTabResumeBinding(tab.id, undefined);
    onOpenChange(false);
  };

  const manualIdValid = UUID_PATTERN.test(manualId.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("sessionBindTitle")}</DialogTitle>
          <DialogDescription>
            {tab.resumeId
              ? t("sessionBindCurrent", {
                  id: tab.resumeId.slice(0, 8),
                  source: tab.resumeIdSource ?? "-",
                })
              : t("sessionBindNone")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
          {loading && (
            <p className="text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("sessionBindLoading")}
            </p>
          )}
          {!loading && loadError && (
            <p className="text-[12px] text-[var(--app-status-danger)]">{loadError}</p>
          )}
          {!loading && !loadError && candidates.length === 0 && (
            <p className="text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("sessionBindEmpty")}
            </p>
          )}
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => bind(candidate.id)}
              className="text-left rounded-md px-2 py-1.5 hover:bg-[var(--app-hover)] transition-colors"
              style={{ border: "1px solid var(--app-border)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px]" style={{ color: "var(--app-text-secondary)" }}>
                  {candidate.id.slice(0, 8)}
                  {tab.resumeId === candidate.id ? ` · ${t("sessionBindBoundMark")}` : ""}
                </span>
                <span className="text-[11px] shrink-0" style={{ color: "var(--app-text-tertiary)" }}>
                  {new Date(candidate.modifiedAt * 1000).toLocaleString()}
                </span>
              </div>
              <div className="text-[12px] truncate" style={{ color: "var(--app-text-primary)" }}>
                {candidate.description || t("sessionBindNoDescription")}
              </div>
            </button>
          ))}
        </div>

        <div className="flex gap-2 items-center">
          <Input
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            placeholder={t("sessionBindManualPlaceholder")}
            className="font-mono text-[12px]"
          />
          <Button size="sm" disabled={!manualIdValid} onClick={() => bind(manualId.trim())}>
            {t("sessionBindAction")}
          </Button>
        </div>

        {tab.resumeId && (
          <Button size="sm" variant="outline" onClick={unbind}>
            {t("sessionBindUnbind")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
