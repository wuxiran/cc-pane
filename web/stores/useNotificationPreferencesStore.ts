import { create } from "zustand";
import { listenIfTauri } from "@/services/runtime";
import { notificationPreferencesService, emptyNotificationPreferences, type LayoutSound, type NotificationPreferences } from "@/services/notificationPreferencesService";

interface PreferencesState {
  preferences: NotificationPreferences;
  ready: boolean;
  error: string | null;
  load: () => Promise<void>;
  setSound: (layoutId: string, sound: LayoutSound) => Promise<void>;
  snooze: (sessionId: string, until: number | null) => Promise<void>;
  prune: () => void;
}
let loading: Promise<void> | null = null;
export const useNotificationPreferencesStore = create<PreferencesState>((set, get) => ({
  preferences: emptyNotificationPreferences(), ready: false, error: null,
  load: () => {
    if (get().ready) return Promise.resolve();
    loading ??= notificationPreferencesService.get().then(preferences => { set({ preferences: preferences ?? emptyNotificationPreferences(), ready: true, error: null }); })
      .catch(error => { set({ ready: true, error: String(error) }); })
      .finally(() => { loading = null; });
    return loading;
  },
  setSound: async (layoutId, sound) => { set({ preferences: await notificationPreferencesService.setSound(layoutId, sound) }); },
  snooze: async (sessionId, until) => { set({ preferences: await notificationPreferencesService.snooze(sessionId, until) }); },
  prune: () => set(s => ({ preferences: { ...s.preferences,
    sessionSnoozes: Object.fromEntries(Object.entries(s.preferences.sessionSnoozes).filter(([, until]) => until > Date.now())) } })),
}));

export function isSessionSnoozed(id: string | undefined, now = Date.now()): boolean {
  return Boolean(id && (useNotificationPreferencesStore.getState().preferences.sessionSnoozes[id] ?? 0) > now);
}

/** Mounted once by NotificationCenter; listeners are owned by that lifecycle. */
export async function listenNotificationPreferences(): Promise<() => void> {
  return listenIfTauri<NotificationPreferences>("notification-preferences-changed", event => {
    useNotificationPreferencesStore.setState({ preferences: event.payload, ready: true });
  });
}
