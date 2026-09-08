import { useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePanesStore } from "@/stores/usePanesStore";
import { useNotificationStore } from "@/stores/useNotificationStore";
import { useNotificationPreferencesStore } from "@/stores/useNotificationPreferencesStore";
import { notificationPreferencesService, type LayoutSound } from "@/services/notificationPreferencesService";

export function snoozeUntil(kind: string, minutes: number, now = Date.now()): number {
  if (kind === "today") { const date = new Date(now); date.setHours(24, 0, 0, 0); return date.getTime(); }
  const duration = kind === "hour" ? 60 : kind === "quarter" ? 15 : minutes;
  if (!Number.isInteger(duration) || duration < 1 || duration > 10080) throw new Error("Use 1–10080 minutes");
  return now + duration * 60_000;
}

export function NotificationSoundControl({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation("notifications");
  const layoutId = usePanesStore(s => sessionId ? s.findTabBySessionAcrossLayouts(sessionId)?.layoutId : undefined);
  const name = usePanesStore(s => sessionId ? s.findTabBySessionAcrossLayouts(sessionId)?.layoutName : undefined);
  const selected = useNotificationPreferencesStore(s => layoutId ? s.preferences.layoutSounds[layoutId] : undefined);
  const setSound = useNotificationPreferencesStore(s => s.setSound);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const save = (sound: LayoutSound) => { if (layoutId) return setSound(layoutId, sound); return Promise.resolve(); };
  if (!layoutId) return null;
  return <Popover><PopoverTrigger asChild><button type="button" className="rounded p-1 hover:bg-[var(--app-hover)]"
    title={t("preferences.layoutSound", { name })} aria-label={t("preferences.layoutSound", { name })}>
    {selected?.mode === "silent" ? <BellOff size={14} /> : <Bell size={14} />}</button></PopoverTrigger>
    <PopoverContent side="left" className="w-64 p-3"><fieldset disabled={busy} className="space-y-2 text-xs">
      <p className="font-semibold">{t("preferences.layoutSound", { name })}</p>
      <p className="truncate" title={selected?.mode === "custom" ? selected.name : undefined}>{selected?.mode === "custom" ? selected.name : t(`preferences.${selected?.mode === "silent" ? "silent" : "default"}`)}</p>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={() => void run(async () => { const sound = await notificationPreferencesService.importSound(); if (sound) await save(sound); })}>{t("preferences.chooseSound")}</Button>
        <Button size="sm" variant="outline" onClick={() => void run(() => notificationPreferencesService.play(selected, true))}>{t("preferences.preview")}</Button>
        <Button size="sm" variant="outline" onClick={() => void run(() => save({ mode: "silent" }))}>{t("preferences.silent")}</Button>
        <Button size="sm" variant="ghost" onClick={() => void run(() => save({ mode: "default" }))}>{t("preferences.restoreDefault")}</Button>
      </div>{error && <p role="alert" className="text-destructive">{error}</p>}
    </fieldset></PopoverContent></Popover>;
}

export function NotificationSnoozeControl({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation("notifications");
  const setSnooze = useNotificationPreferencesStore(s => s.snooze);
  const [open, setOpen] = useState(false), [kind, setKind] = useState("quarter"), [minutes, setMinutes] = useState(30);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (!sessionId) return null;
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      await setSnooze(sessionId, snoozeUntil(kind, minutes));
      useNotificationStore.setState(s => ({ activeToastIds: s.activeToastIds.filter(id => s.notifications.find(n => n.id === id)?.sessionId !== sessionId) }));
      setOpen(false);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="mt-2 flex justify-end"><Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button size="sm" variant="ghost" className="h-6 gap-1 text-xs"><BellOff size={12} />{t("preferences.snooze")}</Button></PopoverTrigger>
    <PopoverContent side="top" className="w-64 space-y-2 text-xs"><p>{t("preferences.snoozeDescription")}</p>
      <select aria-label={t("preferences.duration")} value={kind} onChange={e => setKind(e.target.value)} className="w-full rounded bg-[var(--app-content)] p-2">
        <option value="quarter">{t("preferences.quarter")}</option><option value="hour">{t("preferences.hour")}</option><option value="today">{t("preferences.today")}</option><option value="custom">{t("preferences.custom")}</option>
      </select>
      {kind === "custom" && <input type="number" min={1} max={10080} value={minutes} aria-label={t("preferences.minutes")} onChange={e => setMinutes(Number(e.target.value))} className="w-full rounded bg-[var(--app-content)] p-2" />}
      <Button size="sm" disabled={busy} onClick={() => void apply()}>{t("preferences.apply")}</Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </PopoverContent></Popover></div>;
}

export function SnoozedNotifications() {
  const { t } = useTranslation("notifications");
  const snoozes = useNotificationPreferencesStore(s => s.preferences.sessionSnoozes);
  const cancel = useNotificationPreferencesStore(s => s.snooze);
  const [error, setError] = useState<string | null>(null);
  const entries = Object.entries(snoozes).filter(([, until]) => until > Date.now());
  if (entries.length === 0) return null;
  return <div className="max-h-36 space-y-1 overflow-auto border-b border-[var(--app-border)] p-2 text-xs">
    <p className="font-semibold">{t("preferences.snoozedSessions")}</p>
    {entries.map(([id, until]) => {
      const location = usePanesStore.getState().findTabBySessionAcrossLayouts(id);
      return <div key={id} className="flex items-center gap-1"><span className="min-w-0 flex-1 truncate" title={`${location?.layoutName ?? ""} ${id}`}>{location?.tab.title ?? id.slice(0, 8)} · {new Date(until).toLocaleTimeString()}</span>
        <Button size="sm" variant="ghost" onClick={() => { void cancel(id, null).catch(e => setError(String(e))); }}>{t("preferences.cancel")}</Button></div>;
    })}{error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
