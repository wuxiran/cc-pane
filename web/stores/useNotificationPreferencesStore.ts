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

/**
 * 「notification-preferences-changed」事件的统一刷新入口：带偏好快照直接采用；
 * 无 payload（托盘等入口即改即通知）则清掉 ready 短路、走 load 通道向后端重取。
 */
export function applyNotificationPreferencesEvent(
  payload: NotificationPreferences | null | undefined,
): void {
  if (payload) {
    useNotificationPreferencesStore.setState({ preferences: payload, ready: true });
    return;
  }
  if (useNotificationPreferencesStore.getState().ready) {
    useNotificationPreferencesStore.setState({ ready: false });
  }
  void useNotificationPreferencesStore.getState().load();
}

/** Mounted once by NotificationCenter; listeners are owned by that lifecycle. */
export async function listenNotificationPreferences(): Promise<() => void> {
  return listenIfTauri<NotificationPreferences | null>("notification-preferences-changed", event => {
    applyNotificationPreferencesEvent(event.payload);
  });
}
