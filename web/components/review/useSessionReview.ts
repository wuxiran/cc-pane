import { useCallback, useEffect, useState } from "react";
import { gitService } from "@/services/gitService";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import type { TurnCheckpointRecord } from "@/types/turnCheckpoint";
import { getErrorMessage } from "@/utils";
import { loadReviewSource, type ReviewFile, type ReviewScope } from "./reviewData";

export function useSessionReview(projectPath: string, chatId: string | undefined, open: boolean) {
  const [scope, setScope] = useState<ReviewScope>("workspace");
  const [baseRef, setBaseRef] = useState("");
  const [checkpointId, selectCheckpoint] = useState("");
  const [records, setRecords] = useState<TurnCheckpointRecord[]>([]);
  const [files, setFiles] = useState<ReviewFile[]>([]);
  const [root, setRoot] = useState(projectPath);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [range, setRange] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    selectCheckpoint(""); setRecords([]); setFiles([]); setError(null); setCheckpointError(null);
    setBaseRef(""); setScope("workspace"); setNotice(null); setRange(null); setBranches([]); setBranchError(null); setRecordsLoading(false); setBranchesLoading(false);
  }, [projectPath, chatId]);

  useEffect(() => {
    if (!open || scope !== "branch") return;
    let cancelled = false;
    setBranchesLoading(true); setBranchError(null);
    void Promise.all([gitService.getLocalBranches(projectPath), gitService.getRepoInfo(projectPath)]).then(([items, repo]) => {
      if (cancelled) return;
      setBranches(items);
      const preferred = ["main", "master"].find((branch) => branch !== repo.branch && items.includes(branch));
      if (preferred) setBaseRef((previous) => previous || preferred);
    }).catch((cause) => { if (!cancelled) setBranchError(getErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, scope, open]);

  useEffect(() => {
    if (!open || !chatId) return;
    let cancelled = false;
    setRecordsLoading(true); setCheckpointError(null);
    void turnCheckpointService.list(chatId).then((items) => {
      if (cancelled) return;
      setRecords(items);
      selectCheckpoint((previous) => items.some((record) => record.id === previous && record.completedAt)
        ? previous : items.find((record) => record.completedAt)?.id ?? "");
    }).catch((cause) => { if (!cancelled) { setRecords([]); setCheckpointError(getErrorMessage(cause)); } })
      .finally(() => { if (!cancelled) setRecordsLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, chatId, open, refresh]);

  useEffect(() => {
    let cancelled = false;
    setFiles([]); setError(null); setNotice(null); setRange(null); setRoot(projectPath);
    if (!open || (scope === "turn" && !checkpointId) || (scope === "branch" && !baseRef)) { setLoading(false); return; }
    setLoading(true);
    void loadReviewSource(projectPath, scope, checkpointId, baseRef).then(async (source) => {
      if (cancelled) return;
      setRoot(source.root); setNotice(source.notice ?? null);
      setRange(source.baseCommit && source.headCommit ? `${source.baseCommit.slice(0, 8)} → ${source.headCommit.slice(0, 8)}` : null);
      setFiles(source.files);
      let next = 0;
      // Bound concurrent IPC work; obsolete requests cannot paint another scope/session.
      const worker = async () => {
        while (!cancelled && next < source.files.length) {
          const index = next++;
          let patch: Partial<ReviewFile>;
          try { patch = { diff: await source.readDiff(index) }; }
          catch (cause) { patch = { error: getErrorMessage(cause) }; }
          if (!cancelled) setFiles((current) => current.map((file, i) => i === index ? { ...file, ...patch } : file));
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, source.files.length) }, worker));
    }).catch((cause) => { if (!cancelled) setError(getErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, open, scope, checkpointId, baseRef, refresh]);

  return { scope, setScope, baseRef, setBaseRef, checkpointId, selectCheckpoint, records, files,
    root, notice, error, checkpointError, loading, recordsLoading, range, branches, branchError, branchesLoading, reload };
}
