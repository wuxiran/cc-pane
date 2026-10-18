import "@/i18n/forkReviewResources";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { forkReviewService } from "@/services/forkReviewService";
import type { ForkComparison, ForkReviewRecord } from "@/types/forkReview";
import { getErrorMessage } from "@/utils";
import ForkFilePreview from "./ForkFilePreview";
import { adoptionSelections, relatedForks, toggleForkHunk, type ForkSelections } from "./forkReviewSelection";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forkReviewId?: string;
  cwd?: string;
  sourceSessionId?: string;
}

const label = (record: ForkReviewRecord) => `${record.title || record.engineId || record.id.slice(0, 8)} · ${new Date(record.createdAt).toLocaleString()} · ${record.targetCwd}`;

export default function ForkReviewDialog({ open, onOpenChange, forkReviewId, cwd, sourceSessionId }: Props) {
  const { t } = useTranslation("panes");
  const [records, setRecords] = useState<ForkReviewRecord[]>([]);
  const [selectedId, setSelectedId] = useState(forkReviewId ?? "");
  const [comparison, setComparison] = useState<ForkComparison | null>(null);
  const [referenceId, setReferenceId] = useState("");
  const [reference, setReference] = useState<ForkComparison | null>(null);
  const [selections, setSelections] = useState<ForkSelections>({});
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const requestSequence = useRef(0);
  const anchor = records.find((record) => record.id === forkReviewId);
  const candidates = useMemo(() => relatedForks(records, anchor, cwd, sourceSessionId), [records, anchor, cwd, sourceSessionId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    forkReviewService.list().then((items) => {
      if (cancelled) return;
      setRecords(items);
      if (!forkReviewId) setSelectedId(relatedForks(items, undefined, cwd, sourceSessionId)[0]?.id ?? "");
    }).catch((cause) => { if (!cancelled) setError(getErrorMessage(cause)); });
    return () => { cancelled = true; };
  }, [open, forkReviewId, cwd, sourceSessionId]);

  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setComparison(null);
    setSelections({});
    setError(null);
    setStale(false);
    if (!selectedId) return;
    setLoading(true);
    try {
      const result = await forkReviewService.compare(selectedId);
      if (sequence !== requestSequence.current) return;
      setComparison(result);
      setPath((previous) => result.files.some((file) => file.path === previous) ? previous : result.files[0]?.path ?? "");
    } catch (cause) {
      if (sequence === requestSequence.current) setError(getErrorMessage(cause));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [selectedId]);
  useEffect(() => {
    if (open) { setNotice(null); void reload(); }
    return () => { requestSequence.current++; };
  }, [open, reload]);

  useEffect(() => {
    let cancelled = false;
    setReference(null);
    if (referenceId) forkReviewService.compare(referenceId).then((result) => {
      if (!cancelled) setReference(result);
    }).catch((cause) => { if (!cancelled) setError(getErrorMessage(cause)); });
    return () => { cancelled = true; };
  }, [referenceId]);

  const apply = async () => {
    if (!comparison || stale || comparison.sharedDirectory) return;
    setApplying(true);
    setError(null);
    try {
      const result = await forkReviewService.apply(comparison.record.id, { revision: comparison.revision, selections: adoptionSelections(selections) });
      setNotice([t("forkReviewApplied", { defaultValue: "Adopted {{count}} files into the parent directory.", count: result.appliedPaths.length }), result.refreshWarning].filter(Boolean).join(" "));
      await reload();
    } catch (cause) {
      setError(getErrorMessage(cause));
      setStale(true);
    } finally { setApplying(false); }
  };
  const files = useMemo(() => {
    const changed = comparison?.files ?? [];
    if (!reference) return changed;
    const paths = new Set(changed.map((file) => file.path));
    const referenceOnly = reference.files.filter((file) => !paths.has(file.path)).map((file) => ({
      ...file, supported: false, conflict: false, parentChanged: false, hunks: [],
      status: "modified" as const, childContent: file.baseContent ?? "",
      reason: t("forkReviewOtherCandidateOnly", { defaultValue: "Only the other candidate changed this file; there is no change to adopt from the selected candidate." }),
    }));
    return [...changed, ...referenceOnly];
  }, [comparison, reference, t]);
  const selectedFile = files.find((file) => file.path === path);
  const blocked = loading || applying || stale || !comparison || comparison.record.id !== selectedId || comparison.sharedDirectory;
  const compatibleReferences = candidates.filter((record) => record.id !== selectedId && record.baseline.tree === comparison?.record.baseline.tree);
  const selectedCount = adoptionSelections(selections).length;

  return <Dialog open={open} onOpenChange={(value) => { if (!applying) onOpenChange(value); }}>
    <DialogContent className="flex h-[85vh] max-h-[900px] flex-col gap-3 sm:max-w-6xl" showCloseButton={!applying}>
      <DialogHeader>
        <DialogTitle>{t("forkReviewTitle", { defaultValue: "Compare fork results" })}</DialogTitle>
        <DialogDescription>{t("forkReviewDescription", { defaultValue: "Review changes since the saved fork baseline, then select files or hunks to adopt into the parent directory." })}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="min-w-0 flex-1 space-y-1">
          <span>{t("forkReviewCandidate", { defaultValue: "Candidate fork" })}</span>
          <select className="block w-full rounded border bg-[var(--app-panel-bg)] p-2" value={selectedId} disabled={applying} onChange={(event) => { setSelectedId(event.target.value); setReferenceId(""); }}>
            {!candidates.length && <option value={selectedId}>{t("forkReviewNoBaseline", { defaultValue: "No saved fork baseline is available" })}</option>}
            {candidates.map((record) => <option key={record.id} value={record.id}>{label(record)}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex-1 space-y-1">
          <span>{t("forkReviewCompareWith", { defaultValue: "Compare with another candidate" })}</span>
          <select className="block w-full rounded border bg-[var(--app-panel-bg)] p-2" value={referenceId} disabled={applying || loading} onChange={(event) => setReferenceId(event.target.value)}>
            <option value="">{t("forkReviewBaselineOnly", { defaultValue: "Saved baseline only" })}</option>
            {compatibleReferences.map((record) => <option key={record.id} value={record.id}>{label(record)}</option>)}
          </select>
        </label>
        <Button variant="outline" disabled={loading || applying || !selectedId} onClick={() => void reload()}>{t("forkReviewReload", { defaultValue: "Reload comparison" })}</Button>
      </div>
      {comparison && <div className="space-y-1 rounded border p-2 text-xs text-[var(--app-text-secondary)]">
        <p className="break-all">{t("forkReviewOrigin", { defaultValue: "Parent: {{cwd}} · Session: {{session}}", cwd: comparison.record.sourceCwd, session: comparison.record.sourceSessionId || comparison.record.sourceTabId || "—" })}</p>
        <p className="break-all">{t("forkReviewTarget", { defaultValue: "Fork: {{cwd}} · Baseline: {{head}}", cwd: comparison.record.targetCwd, head: comparison.record.baseline.head.slice(0, 12) })}</p>
      </div>}
      {comparison?.sharedDirectory && <p role="status" className="rounded border p-2 text-xs">{t("forkReviewShared", { defaultValue: "These conversations share one directory. Changes are already shared and cannot be attributed to one conversation; adoption is unavailable." })}</p>}
      {error && <p role="alert" className="text-xs text-[var(--destructive)]">{error}{stale && ` ${t("forkReviewReloadRequired", { defaultValue: "Reload the comparison and review your selections before trying again." })}`}</p>}
      {notice && <p role="status" className="text-xs text-[var(--app-status-success)]">{notice}</p>}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded border">
        <div className="w-64 shrink-0 overflow-auto border-r">
          {files.map((file) => <div key={file.path} className={`flex items-start gap-2 border-b p-2 text-xs ${path === file.path ? "bg-[var(--app-active-bg)]" : ""}`}>
            <input type="checkbox" aria-label={t("forkReviewSelectFile", { defaultValue: "Select file {{path}}", path: file.path })} className="mt-1"
              checked={Object.prototype.hasOwnProperty.call(selections, file.path)} disabled={blocked || !file.supported || file.conflict}
              ref={(node) => { if (node) node.indeterminate = Array.isArray(selections[file.path]); }}
              onChange={(event) => setSelections((previous) => { const next = { ...previous }; if (event.target.checked) next[file.path] = null; else delete next[file.path]; return next; })} />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setPath(file.path)}>
              <span className="block break-all font-mono">{file.path}</span>
              <span className="text-[var(--app-text-tertiary)]">{file.status}{file.conflict ? " · ⚠" : file.parentChanged ? " · ↔" : ""}</span>
            </button>
          </div>)}
        </div>
        {selectedFile ? <ForkFilePreview file={selectedFile} selection={selections[selectedFile.path]} disabled={blocked || !selectedFile.supported}
          onToggleHunk={(id) => setSelections((previous) => toggleForkHunk(previous, selectedFile, id))}
          reference={reference?.files.find((file) => file.path === selectedFile.path)} compareCandidates={Boolean(reference)} />
          : <p className="p-4 text-sm text-[var(--app-text-secondary)]">{loading ? t("forkReviewLoading", { defaultValue: "Loading comparison…" }) : t("forkReviewNoChanges", { defaultValue: "No changes to review. Older forks without a saved baseline cannot be compared." })}</p>}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-[var(--app-text-secondary)]">{t("forkReviewSelected", { defaultValue: "{{count}} files selected", count: selectedCount })}</span>
        <Button disabled={blocked || selectedCount === 0} onClick={() => void apply()}>{t("forkReviewAdopt", { defaultValue: "Adopt into parent directory" })}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
