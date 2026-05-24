import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";

const NOTIFICATION_STORAGE_KEY = "cc-panes-orchestration-notifications";
const MAX_NOTIFICATIONS = 100;

export interface NotificationRecord {
  id: string;
  kind: string;
  title: string;
  body?: string;
  source?: string;
  scope?: string;
  dedupeKey?: string;
  taskBindingId?: string;
  groupKey?: string;
  timestamp: number;
}

interface NotificationStoreState {
  notifications: NotificationRecord[];
  _unlisten: UnlistenFn | null;
  _initialized: boolean;
  init: () => Promise<void>;
  cleanup: () => void;
  add: (notification: NotificationRecord) => void;
  clear: () => void;
}

type NotificationSentPayload = {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  source?: unknown;
  scope?: unknown;
  dedupeKey?: unknown;
  groupKey?: unknown;
  taskBindingId?: unknown;
  timestamp?: unknown;
  metadata?: unknown;
};

function readStoredNotifications(): NotificationRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTIFICATIONS) : [];
  } catch {
    return [];
  }
}

function writeStoredNotifications(notifications: NotificationRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      NOTIFICATION_STORAGE_KEY,
      JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS))
    );
  } catch {
    // Ignore storage failures; the in-memory ring buffer still works.
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeNotification(payload: NotificationSentPayload): NotificationRecord {
  const metadata = asRecord(payload.metadata);
  return {
    id: optionalString(payload.id) ?? randomId(),
    kind: optionalString(payload.kind) ?? "notification",
    title: optionalString(payload.title) ?? "Notification",
    body: optionalString(payload.body),
    source: optionalString(payload.source),
    scope: optionalString(payload.scope),
    dedupeKey: optionalString(payload.dedupeKey),
    groupKey: optionalString(payload.groupKey),
    taskBindingId:
      optionalString(payload.taskBindingId) ??
      optionalString(metadata?.taskBindingId) ??
      optionalString(metadata?.task_binding_id),
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
  };
}

export const useNotificationStore = create<NotificationStoreState>((set, get) => ({
  notifications: readStoredNotifications(),
  _unlisten: null,
  _initialized: false,

  init: async () => {
    if (get()._initialized) return;
    set({ _initialized: true });
    const unlisten = await listen<NotificationSentPayload>("notification-sent", (event) => {
      get().add(normalizeNotification(event.payload ?? {}));
    });
    set({ _unlisten: unlisten });
  },

  cleanup: () => {
    get()._unlisten?.();
    set({ _unlisten: null, _initialized: false });
  },

  add: (notification) => {
    set((state) => {
      const next = [notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS);
      writeStoredNotifications(next);
      return { notifications: next };
    });
  },

  clear: () => {
    writeStoredNotifications([]);
    set({ notifications: [] });
  },
}));
