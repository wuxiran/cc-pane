import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { toastErr } from "@/lib/feedback";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { createSettingsDraft, type SettingsDraft } from "./settingsDraft";
import { applySettingsEdits, collectSettingsEdits, type SettingsEdit } from "./settingsEdits";

export function useSettingsAutosave(open: boolean) {
  const settings = useSettingsStore((state) => state.settings);
  const [draft, setDraft] = useState(() => createSettingsDraft(settings ?? useSettingsStore.getState().getDefaults()));
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const draftRef = useRef(draft);
  const edits = useRef(new Map<string, SettingsEdit>());
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const mounted = useRef(true);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const liveDraft = useCallback(() => {
    const live = createSettingsDraft(useSettingsStore.getState().settings ?? draftRef.current);
    const companion = useCCChanStore.getState();
    return companion.loaded ? { ...live, ccchan: structuredClone(companion.settings) } : live;
  }, []);

  const syncDraft = useCallback(() => {
    const next = applySettingsEdits(liveDraft(), edits.current.values());
    draftRef.current = next;
    if (mounted.current) setDraft(next);
  }, [liveDraft]);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    if (inFlight.current) return inFlight.current;
    const savePending = async () => {
      while (edits.current.size > 0) {
        const batch = new Map(edits.current);
        try {
          const changes = [...batch.values()];
          const companionChanged = changes.some((edit) => edit.path[0] === "ccchan");
          if (companionChanged) {
            const next = applySettingsEdits(liveDraft(), changes);
            await useCCChanStore.getState().saveSettings(next.ccchan);
          }
          // Read again after companion I/O: password clearing may have completed meanwhile.
          const latest = liveDraft();
          if (companionChanged) latest.ccchan = useCCChanStore.getState().settings;
          const next = applySettingsEdits(latest, changes);
          await useSettingsStore.getState().saveSettings(next);
          for (const [key, saved] of batch) {
            if (edits.current.get(key)?.revision === saved.revision) edits.current.delete(key);
          }
          syncDraft();
          if (mounted.current) setLastSavedAt(new Date().toLocaleTimeString());
          if (companionChanged) {
            try {
              await emitTo("ccchan", "ccchan:settings-updated", useCCChanStore.getState().settings);
            } catch { /* The companion window can be closed or absent in web mode. */ }
          }
        } catch (error) {
          clearTimer();
          toastErr(i18n.t("saveFailed", { ns: "common", error }));
          return false;
        }
      }
      return true;
    };
    inFlight.current = savePending().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [clearTimer, liveDraft, syncDraft]);
  flushRef.current = flush;

  const updateDraft = useCallback((next: SettingsDraft) => {
    const changes = collectSettingsEdits(draftRef.current, next, ++revision.current);
    for (const change of changes) edits.current.set(JSON.stringify(change.path), change);
    syncDraft();
    if (changes.length === 0) return;
    clearTimer();
    timer.current = setTimeout(() => { void flushRef.current(); }, 500);
  }, [clearTimer, syncDraft]);

  useEffect(() => {
    if (open) syncDraft();
    else void flush();
  }, [open, settings, flush, syncDraft]);
  useEffect(() => { if (open) setLastSavedAt(null); }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimer(); };
  }, [clearTimer]);

  const discard = useCallback(() => {
    clearTimer();
    edits.current.clear();
    syncDraft();
  }, [clearTimer, syncDraft]);

  return { draft, updateDraft, lastSavedAt, flush, discard };
}
