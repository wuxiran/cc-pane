import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { ForkChangedFile } from "@/types/forkReview";
import { canSelectHunks } from "./forkReviewSelection";

interface Props {
  file: ForkChangedFile;
  selection: string[] | null | undefined;
  disabled: boolean;
  onToggleHunk: (id: string) => void;
  reference?: ForkChangedFile;
  compareCandidates?: boolean;
}

const PATCH_PREVIEW_LINE_LIMIT = 2000;

/** Bound rendered code lines without changing any hunk IDs or application content. */
function Patch({ patch, truncated = false }: { patch: string; truncated?: boolean }) {
  const { t } = useTranslation("panes");
  const lines = patch.split("\n", PATCH_PREVIEW_LINE_LIMIT + 1);
  const clipped = truncated || lines.length > PATCH_PREVIEW_LINE_LIMIT;
  return <>
    <pre className="overflow-x-auto py-1 text-xs leading-5">{lines.slice(0, PATCH_PREVIEW_LINE_LIMIT).map((line, index) => (
      <span key={index} className="block min-h-5 px-3" style={{
        background: line.startsWith("+") ? "var(--app-status-success-bg)" : line.startsWith("-") ? "var(--app-status-danger-bg)" : undefined,
      }}>{line}</span>
    ))}</pre>
    {clipped && <p role="status" className="px-3 py-2 text-xs text-[var(--app-text-secondary)]">{t("forkReviewPreviewTruncated", { defaultValue: "Preview limited to {{count}} lines. Adoption still uses the complete selected hunks or files.", count: PATCH_PREVIEW_LINE_LIMIT })}</p>}
  </>;
}

function hunkPages(file: ForkChangedFile) {
  const pages: Array<Array<{ hunk: ForkChangedFile["hunks"][number]; index: number }>> = [[]];
  let lines = 0;
  file.hunks.forEach((hunk, index) => {
    const size = hunk.patch.split("\n", PATCH_PREVIEW_LINE_LIMIT).length;
    if (lines && lines + size > PATCH_PREVIEW_LINE_LIMIT) { pages.push([]); lines = 0; }
    pages[pages.length - 1].push({ hunk, index });
    lines += size;
  });
  return pages;
}

function CandidateDelta({ file, reference }: { file: ForkChangedFile; reference?: ForkChangedFile }) {
  const { t } = useTranslation("panes");
  // A missing changed-file entry means this candidate still has the shared baseline.
  const before = reference ? (reference.status === "deleted" ? "" : reference.childContent) : (file.baseContent ?? (file.status === "added" ? "" : undefined));
  const after = file.status === "deleted" ? "" : file.childContent;
  if (file.binary || reference?.binary || before === undefined || after === undefined) {
    return <p className="p-3 text-xs">{t("forkReviewCandidateUnavailable", { defaultValue: "This candidate comparison has a binary or unavailable file; inspect the individual changes below." })}</p>;
  }
  if (before === after) return <p className="p-3 text-xs">{t("forkReviewCandidatesEqual", { defaultValue: "Both candidates have the same content for this file." })}</p>;
  const left = before.split("\n");
  const right = after.split("\n");
  let start = 0;
  let end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
  const delta = [
    `@@ -${start + 1},${left.length - start - end} +${start + 1},${right.length - start - end} @@`,
    ...left.slice(start, Math.min(left.length - end, start + PATCH_PREVIEW_LINE_LIMIT)).map((line) => `-${line}`),
    ...right.slice(start, Math.min(right.length - end, start + PATCH_PREVIEW_LINE_LIMIT)).map((line) => `+${line}`),
  ].join("\n");
  return <Patch patch={delta} truncated={left.length + right.length - 2 * (start + end) + 1 > PATCH_PREVIEW_LINE_LIMIT} />;
}

export default function ForkFilePreview({ file, selection, disabled, onToggleHunk, reference, compareCandidates }: Props) {
  const { t } = useTranslation("panes");
  const partial = canSelectHunks(file);
  const [page, setPage] = useState(0);
  const pages = useMemo(() => hunkPages(file), [file]);
  const currentPage = Math.min(page, pages.length - 1);
  useEffect(() => { setPage(0); }, [file.path]);
  return <div className="min-w-0 flex-1 overflow-auto" aria-label={t("forkReviewDiff", { defaultValue: "Fork changes" })}>
    <div className="sticky top-0 z-10 space-y-2 border-b bg-[var(--app-panel-bg)] p-3">
      <div className="break-all font-mono text-xs">{file.path}</div>
      {file.conflict && <p role="alert" className="text-xs text-[var(--destructive)]">{partial
        ? t("forkReviewPartialConflict", { defaultValue: "Whole-file adoption conflicts with parent changes. You may select individual hunks; the selected changes will be checked for conflicts again before adoption." })
        : t("forkReviewConflict", { defaultValue: "This file conflicts with changes in the parent directory. Resolve the conflict before adopting it." })}</p>}
      {file.parentChanged && !file.conflict && <p className="text-xs text-[var(--app-status-warning)]">{t("forkReviewParentChanged", { defaultValue: "The parent also changed this file. Adoption will preserve compatible parent changes." })}</p>}
      {!file.supported && <p role="alert" className="text-xs">{file.reason || t("forkReviewUnsupported", { defaultValue: "This file cannot be adopted automatically." })}</p>}
    </div>
    {compareCandidates && <section className="border-b">
      <h3 className="px-3 pt-3 text-xs font-semibold">{t("forkReviewCandidateDelta", { defaultValue: "Other candidate → selected candidate (preview only)" })}</h3>
      <CandidateDelta file={file} reference={reference} />
    </section>}
    {compareCandidates && <h3 className="px-3 pt-3 text-xs font-semibold">{t("forkReviewBaselineDelta", { defaultValue: "Fork baseline → selected candidate (adoption selection)" })}</h3>}
    {pages.length > 1 && <div className="flex items-center justify-between gap-2 border-b p-2 text-xs">
      <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("forkReviewPreviousHunks", { defaultValue: "Previous hunks" })}</Button>
      <span>{t("forkReviewHunkPage", { defaultValue: "Hunk page {{page}} of {{count}}", page: currentPage + 1, count: pages.length })}</span>
      <Button variant="outline" size="sm" disabled={currentPage + 1 === pages.length} onClick={() => setPage(currentPage + 1)}>{t("forkReviewNextHunks", { defaultValue: "Next hunks" })}</Button>
    </div>}
    {pages[currentPage].map(({ hunk, index }) => <section key={hunk.id} className="border-b">
      <label className="flex items-center gap-2 bg-[var(--app-active-bg)] p-2 font-mono text-xs">
        {partial && <input type="checkbox" aria-label={t("forkReviewSelectHunk", { defaultValue: "Select hunk {{number}}", number: index + 1 })}
          checked={selection === null || Boolean(selection?.includes(hunk.id))} disabled={disabled} onChange={() => onToggleHunk(hunk.id)} />}
        {hunk.header}
      </label>
      <Patch patch={hunk.patch} />
    </section>)}
    {!file.hunks.length && <p className="p-3 text-xs text-[var(--app-text-secondary)]">{t(file.binary ? "forkReviewBinary" : "forkReviewWholeFile", { defaultValue: file.binary ? "Binary file: select the whole file to adopt it." : "Select the whole file to adopt this change." })}</p>}
  </div>;
}
