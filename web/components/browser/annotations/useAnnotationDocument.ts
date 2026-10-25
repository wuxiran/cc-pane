import { useCallback, useEffect, useRef, useState } from "react";
import { captureAnnotationFrame, saveBrowserAnnotation, type SavedAnnotation } from "@/services/browserAnnotationService";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import { getErrorMessage } from "@/utils";
import type { AnnotationFrame, BrowserAnnotation } from "./annotationModel";

export function useAnnotationDocument(tabId: string) {
  const [frame, setFrame] = useState<AnnotationFrame | null>(null);
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedAnnotation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0); const lock = useRef(false);
  const cache = useRef<{ signature: string; saved: SavedAnnotation } | null>(null);
  const signature = JSON.stringify(annotations);
  useEffect(() => {
    const request = ++epoch.current;
    const blocker = `browser-annotation:${tabId}:${crypto.randomUUID()}`;
    lock.current = false; setBusy(false); setNotice(null);
    setFrame(null); setAnnotations([]); setLoading(true); setError(null); setSaved(null); cache.current = null;
    useBrowserWebviewOverlayStore.getState().setBlocked(blocker, true);
    void captureAnnotationFrame(tabId).then((value) => { if (request === epoch.current) setFrame(value); })
      .catch((cause) => { if (request === epoch.current) setError(getErrorMessage(cause)); })
      .finally(() => { if (request === epoch.current) setLoading(false); });
    return () => { epoch.current++; useBrowserWebviewOverlayStore.getState().setBlocked(blocker, false); };
  }, [tabId]);
  const perform = useCallback(async (operation?: (value: SavedAnnotation) => Promise<void>, message?: string) => {
    if (!frame || lock.current) return;
    const request = epoch.current; lock.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const value = cache.current?.signature === signature ? cache.current.saved : await saveBrowserAnnotation(frame, annotations);
      if (request !== epoch.current) return;
      cache.current = { signature, saved: value }; setSaved(value);
      if (operation) await operation(value);
      if (request === epoch.current) setNotice(message ?? value.filePath);
    } catch (cause) { if (request === epoch.current) setError(getErrorMessage(cause)); }
    finally { if (request === epoch.current) { lock.current = false; setBusy(false); } }
  }, [frame, annotations, signature]);
  return { frame, annotations, setAnnotations, loading, busy, error, saved, notice, perform,
    dirty: annotations.length > 0 && cache.current?.signature !== signature };
}
