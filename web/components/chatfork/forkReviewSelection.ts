import { projectPathsEquivalent } from "@/utils/projectIdentity";
import type { ForkChangedFile, ForkReviewRecord, ForkSelection } from "@/types/forkReview";

/** null means the whole file; an array always means an explicit hunk subset. */
export type ForkSelections = Record<string, string[] | null>;

export function canSelectHunks(file: ForkChangedFile): boolean {
  return file.supported && !file.wholeFileOnly && !file.binary && file.status === "modified" && file.hunks.length > 0;
}

export function toggleForkHunk(selections: ForkSelections, file: ForkChangedFile, id: string): ForkSelections {
  const current = selections[file.path];
  const selected = new Set(current === null ? file.hunks.map((hunk) => hunk.id) : current ?? []);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  const next = { ...selections };
  if (selected.size) next[file.path] = [...selected];
  else delete next[file.path];
  return next;
}

export function adoptionSelections(selections: ForkSelections): ForkSelection[] {
  return Object.entries(selections).flatMap(([path, hunkIds]) =>
    hunkIds === null ? [{ path }] : hunkIds.length ? [{ path, hunkIds }] : [],
  );
}

export function relatedForks(records: ForkReviewRecord[], current?: ForkReviewRecord, cwd?: string, sessionId?: string): ForkReviewRecord[] {
  const sourceCwd = current?.sourceCwd ?? cwd;
  const sourceSessionId = current?.sourceSessionId ?? sessionId;
  return records.filter((record) => record.id === current?.id || (
    sourceCwd !== undefined && projectPathsEquivalent(record.sourceCwd, sourceCwd)
      && (!sourceSessionId || record.sourceSessionId === sourceSessionId)
  ));
}
