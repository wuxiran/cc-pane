// 「从 GitHub Issue 导入」：列出项目仓库的 issue（经本机 gh），勾选后生成项目 Todo。
// 已导入过的 issue 置灰不可选（后端按 issue URL 去重，重复导入也只返回已有任务）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleDot, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { githubService } from "@/services/githubService";
import { toastErr, toastOk } from "@/lib/feedback";
import type { GithubIssue, GithubIssueImportResult } from "@/types";

interface GithubIssueImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  /** 导入完成（至少新建了一个任务）后回调，用于刷新列表 */
  onImported: () => void;
}

/** 汇总导入结果：新建数 / 已存在数 / 失败数 */
export function summarizeImport(results: GithubIssueImportResult[]) {
  return {
    created: results.filter((r) => r.todo && !r.alreadyImported).length,
    existing: results.filter((r) => r.alreadyImported).length,
    failed: results.filter((r) => r.error).length,
  };
}

export default function GithubIssueImportDialog({
  open,
  onOpenChange,
  projectPath,
  onImported,
}: GithubIssueImportDialogProps) {
  const { t } = useTranslation("dialogs");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      setIssues(await githubService.listIssues(projectPath, search));
    } catch (error) {
      setLoadError(String(error));
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setQuery("");
    void load("");
  }, [open, load]);

  const toggle = (number: number, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, number] : prev.filter((n) => n !== number)));
  };

  const handleImport = async () => {
    if (!selected.length) return;
    setImporting(true);
    try {
      const results = await githubService.importIssues(projectPath, selected);
      const summary = summarizeImport(results);
      if (summary.failed) {
        toastErr(t("githubImportPartialFailed", { ...summary }));
      } else {
        toastOk(t("githubImportDone", { ...summary }));
      }
      if (summary.created) onImported();
      onOpenChange(false);
    } catch (error) {
      toastErr(t("githubImportFailed", { error: String(error) }));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t("githubImportTitle")}</DialogTitle>
          <DialogDescription>{t("githubImportDesc")}</DialogDescription>
        </DialogHeader>

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query);
          }}
        >
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("githubImportSearchPlaceholder")}
            aria-label={t("githubImportSearchPlaceholder")}
          />
          <Button type="submit" variant="outline" disabled={loading} className="shrink-0 gap-1.5">
            <RefreshCw size={14} />
            {t("githubImportSearch")}
          </Button>
        </form>

        <div className="app-scrollbar min-h-[200px] flex-1 space-y-1.5 overflow-y-auto">
          {loading && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          {!loading && loadError && (
            <p className="text-xs text-destructive" role="alert">{loadError}</p>
          )}
          {!loading && !loadError && issues.length === 0 && (
            <EmptyState
              icon={CircleDot}
              title={t("githubImportEmpty")}
              action={{ label: t("githubImportReload"), onClick: () => void load(query) }}
              className="py-10"
            />
          )}
          {!loading && issues.map((issue) => {
            const imported = Boolean(issue.importedTodoId);
            return (
              <CheckboxRow
                key={issue.number}
                checked={imported || selected.includes(issue.number)}
                disabled={imported}
                onCheckedChange={(checked) => toggle(issue.number, checked)}
                label={
                  <span>
                    <span className="mr-1.5 tabular-nums text-[var(--app-text-tertiary)]">#{issue.number}</span>
                    {issue.title}
                  </span>
                }
                description={issue.labels.length ? issue.labels.join(" · ") : undefined}
                trailing={imported ? <Badge variant="outline">{t("githubImportImported")}</Badge> : undefined}
              />
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button onClick={() => void handleImport()} disabled={!selected.length || importing}>
            {importing
              ? t("githubImportImporting")
              : t("githubImportAction", { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
