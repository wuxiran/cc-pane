import { useCallback, useEffect, useRef, useState } from "react";
import { agentRuntimeService } from "@/services/agentRuntimeService";
import type { AcpRunEvent, AcpRunQuery, AcpRunRecord } from "@/types/agentRuntime";
import { getErrorMessage } from "@/utils";

export function useChatRunHistory(query: AcpRunQuery, open: boolean) {
  const [runs, setRuns] = useState<AcpRunRecord[]>([]);
  const [events, setEvents] = useState<AcpRunEvent[]>([]);
  const [selectedId, select] = useState("");
  const [moreRuns, setMoreRuns] = useState(false);
  const [moreEvents, setMoreEvents] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const listEpoch = useRef(0);
  const eventEpoch = useRef(0);
  const nextOffset = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const request = ++listEpoch.current;
    ++eventEpoch.current;
    setRuns([]); setEvents([]); select(""); setMoreRuns(false); setMoreEvents(false); setError(null);
    if (!open) return;
    setLoadingRuns(true);
    void agentRuntimeService.list({ ...JSON.parse(queryKey), offset: 0 }).then((page) => {
      if (request !== listEpoch.current) return;
      setRuns(page.runs); nextOffset.current = page.runs.length;
      setMoreRuns(page.hasMore); select(page.runs[0]?.id ?? "");
    }).catch((failure) => {
      if (request === listEpoch.current) setError(getErrorMessage(failure));
    }).finally(() => { if (request === listEpoch.current) setLoadingRuns(false); });
    return () => { ++listEpoch.current; ++eventEpoch.current; };
  }, [queryKey, open, revision]);

  useEffect(() => {
    const request = ++eventEpoch.current;
    setEvents([]); setMoreEvents(false);
    if (!open || !selectedId) { setLoadingEvents(false); return; }
    setLoadingEvents(true); setError(null);
    void agentRuntimeService.events(selectedId).then((page) => {
      if (request !== eventEpoch.current) return;
      setEvents(page.events); setMoreEvents(page.hasMore);
    }).catch((failure) => {
      if (request === eventEpoch.current) setError(getErrorMessage(failure));
    }).finally(() => { if (request === eventEpoch.current) setLoadingEvents(false); });
    return () => { ++eventEpoch.current; };
  }, [selectedId, open, revision]);

  const loadMoreRuns = useCallback(async () => {
    if (loadingRuns || !moreRuns) return;
    const request = listEpoch.current;
    setLoadingRuns(true); setError(null);
    try {
      const page = await agentRuntimeService.list({ ...query, offset: nextOffset.current });
      if (request !== listEpoch.current) return;
      nextOffset.current += page.runs.length;
      setRuns((previous) => [...previous, ...page.runs.filter((run) => !previous.some((old) => old.id === run.id))]);
      setMoreRuns(page.hasMore && page.runs.length > 0);
    } catch (failure) {
      if (request === listEpoch.current) setError(getErrorMessage(failure));
    } finally { if (request === listEpoch.current) setLoadingRuns(false); }
  }, [query, loadingRuns, moreRuns]);

  const loadMoreEvents = useCallback(async () => {
    if (loadingEvents || !moreEvents || !selectedId) return;
    const request = eventEpoch.current;
    setLoadingEvents(true); setError(null);
    try {
      const page = await agentRuntimeService.events(selectedId, events[events.length - 1]?.seq);
      if (request !== eventEpoch.current) return;
      setEvents((previous) => [...previous, ...page.events.filter((event) => !previous.some((old) => old.seq === event.seq))]);
      setMoreEvents(page.hasMore && page.events.length > 0);
    } catch (failure) {
      if (request === eventEpoch.current) setError(getErrorMessage(failure));
    } finally { if (request === eventEpoch.current) setLoadingEvents(false); }
  }, [selectedId, events, loadingEvents, moreEvents]);

  return { runs, events, selectedId, select, moreRuns, moreEvents, loadingRuns, loadingEvents, error,
    loadMoreRuns, loadMoreEvents, reload: () => refresh((value) => value + 1) };
}
