import { useCallback, useEffect, useRef, useState } from "react";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import type { RestoreTurnCheckpointResult, TurnCheckpointRecord, TurnCheckpointReview } from "@/types/turnCheckpoint";
import { getErrorMessage } from "@/utils";

export function useTurnCheckpoints(chatId: string, open: boolean, generating: boolean, initialCheckpointId?: string) {
  const [records, setRecords] = useState<TurnCheckpointRecord[]>([]);
  const [selectedId, select] = useState(initialCheckpointId ?? "");
  const [review, setReview] = useState<TurnCheckpointReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreTurnCheckpointResult | null>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const sequence = useRef(0);

  useEffect(() => {
    epoch.current++;
    sequence.current++;
    select(initialCheckpointId ?? ""); setRecords([]); setReview(null); setError(null); setResult(null); setRestoring(false);
    return () => { epoch.current++; sequence.current++; };
  }, [chatId, open, initialCheckpointId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void turnCheckpointService.list(chatId).then((items) => {
      if (cancelled) return;
      setRecords(items);
      select((previous) => previous && (previous === initialCheckpointId || items.some((record) => record.id === previous))
        ? previous : initialCheckpointId ?? items[0]?.id ?? "");
      if (!items.length && !initialCheckpointId) setLoading(false);
    }).catch((cause) => {
      if (!cancelled) { setError(getErrorMessage(cause)); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [chatId, open, generating, refresh, initialCheckpointId]);

  useEffect(() => {
    const request = ++sequence.current;
    setReview(null);
    if (!open || !selectedId) return;
    setLoading(true); setError(null);
    void turnCheckpointService.review(selectedId).then((value) => {
      if (request === sequence.current) setReview(value);
    }).catch((cause) => {
      if (request === sequence.current) setError(getErrorMessage(cause));
    }).finally(() => {
      if (request === sequence.current) setLoading(false);
    });
    return () => { sequence.current++; };
  }, [selectedId, open, generating, refresh]);

  const restore = useCallback(async () => {
    if (!review?.canRestore || generating || loading || restoring) return;
    const requestEpoch = epoch.current;
    setRestoring(true); setError(null); setResult(null);
    try {
      const value = await turnCheckpointService.restore(review.record.id, review.revision);
      if (requestEpoch !== epoch.current) return;
      setResult(value);
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (requestEpoch === epoch.current) { setError(getErrorMessage(cause)); setReview(null); }
    } finally {
      if (requestEpoch === epoch.current) setRestoring(false);
    }
  }, [review, generating, loading, restoring]);

  const visibleRecords = review && !records.some((record) => record.id === review.record.id) ? [review.record, ...records] : records;
  return { records: visibleRecords, selectedId, select, review, loading, restoring, error, result, restore,
    reload: () => { setReview(null); setRefresh((value) => value + 1); } };
}
