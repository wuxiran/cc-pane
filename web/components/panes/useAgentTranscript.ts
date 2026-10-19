import { useCallback, useEffect, useRef, useState } from "react";
import { agentTranscriptService } from "@/services/agentTranscriptService";
import { isTranscriptSupportedCliTool } from "@/types/agentTranscript";
import type { ReadAgentTranscriptResult, TranscriptMessage } from "@/types/agentTranscript";

const PAGE_SIZE = 200;

/** Only the latest request for this mounted conversation can update its page. */
export function useAgentTranscript(cliTool?: string | null, resumeId?: string | null, cwd?: string | null) {
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [result, setResult] = useState<ReadAgentTranscriptResult | null>(null);
  const [error, setError] = useState<ReadAgentTranscriptResult | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const cursor = useRef<string | null>(null);
  const committedCount = useRef(0);
  const supported = isTranscriptSupportedCliTool(cliTool);
  const hasResume = Boolean(resumeId && resumeId !== "new");

  const load = useCallback(async (append: boolean) => {
    // A ref closes the gap before React paints a disabled Load earlier button.
    if (append && (pending.current || !cursor.current)) return;
    const request = ++generation.current;
    if (!hasResume || !resumeId || !supported) {
      pending.current = false;
      setLoading(false);
      setLoadingMore(false);
      setResult(null);
      setError(null);
      setMessages([]);
      setHasEarlier(false);
      return;
    }
    pending.current = true;
    setError(null);
    setLoading(!append);
    setLoadingMore(append);
    const current = () => mounted.current && request === generation.current;
    try {
      const next = await agentTranscriptService.read({
        cliTool: cliTool ?? "grok",
        resumeSessionId: resumeId,
        cwd: cwd ?? undefined,
        limit: PAGE_SIZE,
        // Kept for older backends; cursor-aware backends prioritize the stable ID.
        offsetFromEnd: append ? committedCount.current : 0,
        beforeMessageId: append ? cursor.current : undefined,
      });
      if (!current()) return;
      if (next.errorCode) {
        setError(next);
        return;
      }
      const nextCount = (append ? committedCount.current : 0) + next.messages.length;
      // Legacy truncated means either side was omitted. A known total bounds
      // compatibility pagination instead of offering endless empty older pages.
      const earlier = next.messages.length > 0 && (next.hasEarlier ?? (
        next.truncated && (next.totalEstimate == null || nextCount < next.totalEstimate)
      ));
      committedCount.current = nextCount;
      cursor.current = earlier ? (next.nextBeforeMessageId ?? next.messages[0]?.id ?? null) : null;
      setHasEarlier(earlier && cursor.current !== null);
      setResult(next);
      setMessages((previous) => {
        if (!append) return next.messages;
        const existing = new Set(previous.map((message) => message.id));
        return [...next.messages.filter((message) => !existing.has(message.id)), ...previous];
      });
    } catch (caught) {
      if (!current()) return;
      setError({
        messages: [], truncated: false, errorCode: "ioError",
        errorMessage: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (current()) {
        pending.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [cliTool, cwd, hasResume, resumeId, supported]);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => { mounted.current = false; generation.current += 1; };
  }, [load]);

  return {
    loading, loadingMore, result, error, messages,
    // A stale cursor cannot be retried with the same boundary; refresh is the
    // explicit recovery path. Transient I/O errors remain retryable.
    hasEarlier: hasEarlier && error?.errorCode !== "cursorExpired",
    supported, hasResume,
    refresh: () => { void load(false); },
    loadEarlier: () => { void load(true); },
  };
}
