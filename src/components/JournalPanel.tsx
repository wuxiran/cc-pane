import { useState, useEffect } from "react";
import { toast } from "sonner";
import { BookOpen, Save, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { journalService, type JournalIndex } from "@/services";

interface JournalPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
  onSaved?: () => void;
}

export default function JournalPanel({ open, onOpenChange, workspaceName, onSaved }: JournalPanelProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [journalIndex, setJournalIndex] = useState<JournalIndex | null>(null);
  const [journalContent, setJournalContent] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [commits, setCommits] = useState("");

  useEffect(() => {
    if (open && workspaceName) {
      loadJournal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceName]);

  async function loadJournal() {
    if (!workspaceName) return;
    setLoading(true);
    try {
      const [index, content] = await Promise.all([
        journalService.getIndex(workspaceName),
        journalService.getRecentJournal(workspaceName),
      ]);
      setJournalIndex(index);
      setJournalContent(content);
    } catch (e) {
      console.error("Failed to load journal:", e);
    } finally {
      setLoading(false);
    }
  }

  async function saveSession() {
    if (!workspaceName || !title.trim()) return;
    setSaving(true);
    try {
      const commitList = commits.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
      await journalService.addSession(workspaceName, title.trim(), summary.trim(), commitList);
      await loadJournal();
      setTitle("");
      setSummary("");
      setCommits("");
      onSaved?.();
    } catch (e) {
      console.error("Failed to save session:", e);
      toast.error("保存失败: " + e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen size={18} />
            会话日志
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-4 h-[450px]">
          {/* 左侧：添加新会话 */}
          <div
            className="w-[280px] shrink-0 p-4 rounded-lg"
            style={{ border: "1px solid var(--app-border)", background: "var(--app-content)" }}
          >
            <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--app-text-primary)" }}>
              保存会话摘要
            </h3>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs" style={{ color: "var(--app-text-secondary)" }}>标题 *</label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：实现用户认证功能" />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs" style={{ color: "var(--app-text-secondary)" }}>摘要</label>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  className="w-full p-2 rounded-md text-[13px] resize-none outline-none"
                  style={{
                    border: "1px solid var(--app-border)",
                    background: "var(--background)",
                    color: "var(--app-text-primary)",
                  }}
                  placeholder="描述本次会话完成的工作..."
                  rows={4}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs" style={{ color: "var(--app-text-secondary)" }}>Git Commits</label>
                <Input value={commits} onChange={(e) => setCommits(e.target.value)} placeholder="commit hash，多个用逗号分隔" />
              </div>

              <Button className="w-full mt-2" disabled={!title.trim() || saving} onClick={saveSession}>
                <Save size={14} className="mr-2" />
                {saving ? "保存中..." : "保存会话"}
              </Button>
            </div>
          </div>

          {/* 右侧：历史记录 */}
          <div
            className="flex-1 flex flex-col rounded-lg overflow-hidden"
            style={{ border: "1px solid var(--app-border)" }}
          >
            <div
              className="px-4 py-3 flex justify-between items-center"
              style={{ borderBottom: "1px solid var(--app-border)" }}
            >
              <h3 className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>
                历史记录
              </h3>
              {journalIndex && (
                <div className="flex gap-3 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                  <span>共 {journalIndex.total_sessions} 个会话</span>
                  <span>{journalIndex.active_file}</span>
                </div>
              )}
            </div>

            {loading ? (
              <div className="flex-1 flex items-center justify-center" style={{ color: "var(--app-text-tertiary)" }}>
                加载中...
              </div>
            ) : !journalContent ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: "var(--app-text-tertiary)" }}>
                <FileText size={48} />
                <p>暂无会话记录</p>
              </div>
            ) : (
              <pre
                className="flex-1 m-0 p-3 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-words"
                style={{ background: "var(--app-content)" }}
              >
                {journalContent}
              </pre>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
