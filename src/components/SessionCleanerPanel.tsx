import { useState, useEffect, useMemo } from "react";
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
import { formatSize, getFileName } from "@/utils";

interface SessionCleanerPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath?: string;
}

export default function SessionCleanerPanel({ open, onOpenChange, projectPath }: SessionCleanerPanelProps) {
  const [sessions, setSessions] = useState<BrokenSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResults, setCleanResults] = useState<CleanResult[]>([]);

  const panelTitle = useMemo(() => {
    if (projectPath) {
      const name = projectPath.replace(/\\/g, "/").split("/").pop() || projectPath;
      return `会话修复 - ${name}`;
    }
    return "会话修复";
  }, [projectPath]);

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
      console.error("Failed to scan broken sessions:", e);
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
      console.error("Failed to clean session:", e);
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
      console.error("Failed to clean all sessions:", e);
      setCleanResults([]);
    } finally {
      setCleaning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck size={18} />
            {panelTitle}
          </DialogTitle>
        </DialogHeader>

        <p className="text-[13px] leading-relaxed m-0 mb-3" style={{ color: "var(--app-text-secondary)" }}>
          扫描 Claude Code 会话文件中的 <code className="px-1 py-px rounded text-xs" style={{ background: "var(--app-hover)" }}>thinking</code> / <code className="px-1 py-px rounded text-xs" style={{ background: "var(--app-hover)" }}>redacted_thinking</code> 块。这些块可能包含无效签名，导致 API 返回 400 错误。
        </p>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: "var(--app-text-tertiary)" }}>
            <Loader2 size={20} className="animate-spin" />
            <span>正在扫描会话文件...</span>
          </div>
        ) : (
          <>
            {sessions.length === 0 && cleanResults.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: "var(--app-accent)" }}>
                <CheckCircle size={20} />
                <span>未发现含有 thinking 块的会话文件</span>
              </div>
            )}

            {sessions.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
                  <span>发现 {sessions.length} 个文件含有 thinking 块</span>
                  <Button size="sm" variant="destructive" disabled={cleaning} onClick={cleanAll}>
                    {cleaning ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Trash2 size={14} className="mr-1" />}
                    全部清理
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
                        <Badge variant="secondary">{session.thinking_blocks} 个块</Badge>
                        <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{formatSize(session.file_size)}</span>
                        <Button size="sm" variant="outline" disabled={cleaning} onClick={() => cleanOne(session)}>
                          清理
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cleanResults.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-3">
                <div className="text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>清理结果</div>
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
                      {result.success ? `移除 ${result.removed_blocks} 个块` : result.error}
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
