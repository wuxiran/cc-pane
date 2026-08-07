import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenIfTauri } from "@/services/runtime";
// 直接 import 具体模块而非 "@/services" 桶文件：destroyPipeline 的教训——
// 测试 vi.mock 桶文件时直连 import 会绕过 mock，这里从一开始就走具体路径。
import { terminalService } from "@/services/terminalService";
import { useTerminalStatusStore } from "./useTerminalStatusStore";

const NOTIFICATION_STORAGE_KEY = "cc-panes-orchestration-notifications";
const MAX_NOTIFICATIONS = 100;
/** 右下角竖排卡片栈容量（update 卡不占本配额，由 NotificationCenter 单独渲染置顶） */
export const MAX_ACTIVE_TOASTS = 3;

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
  /** 关联的终端会话；requiresInput 时为输入回传目标 */
  sessionId?: string;
  /** AI 声明「需要用户输入」：卡片带输入框 */
  requiresInput?: boolean;
  inputPlaceholder?: string;
  metadata?: Record<string, unknown>;
  read: boolean;
  /** 用户在卡片里回复并成功回传会话的时刻 */
  respondedAt?: number;
}

interface NotificationStoreState {
  notifications: NotificationRecord[];
  /** 右下角卡片栈（新的在前）；不持久化，重启即清 */
  activeToastIds: string[];
  /** 历史面板（铃铛/折叠条展开）开关；StatusBar 与折叠条共用 */
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  _unlisten: UnlistenFn | null;
  _initialized: boolean;
  init: () => Promise<void>;
  cleanup: () => void;
  /** 入历史（未读）。是否弹卡片由调用方过闸门后再 showToast。 */
  add: (notification: NotificationRecord) => void;
  /** 过闸门后把通知提升到右下角栈；askInput 优先占位，其余按时间；超容折叠 */
  showToast: (id: string) => void;
  /** 移出栈并标已读；历史保留 */
  dismissToast: (id: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** 校验会话存在 → submitToSession 回传 → 标 respondedAt；失败抛错由卡片显示 */
  respond: (id: string, text: string) => Promise<void>;
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
  sessionId?: unknown;
  requiresInput?: unknown;
  inputPlaceholder?: unknown;
};

function readStoredNotifications(): NotificationRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 旧格式无 read 字段：迁移为已读，避免升级后未读数虚高
    return parsed.slice(0, MAX_NOTIFICATIONS).map((item) => ({
      read: true,
      ...item,
    }));
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

export function normalizeNotification(payload: NotificationSentPayload): NotificationRecord {
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
    sessionId: optionalString(payload.sessionId),
    requiresInput: payload.requiresInput === true ? true : undefined,
    inputPlaceholder: optionalString(payload.inputPlaceholder),
    metadata: metadata ?? undefined,
    read: false,
  };
}

/** 会话是否仍存活（askInput 卡渲染输入框与提交前的双重校验共用） */
export function isNotificationSessionAlive(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return useTerminalStatusStore.getState().statusMap.has(sessionId);
}

export function selectUnreadCount(state: Pick<NotificationStoreState, "notifications">): number {
  return state.notifications.reduce((count, n) => (n.read ? count : count + 1), 0);
}

export const useNotificationStore = create<NotificationStoreState>((set, get) => ({
  notifications: readStoredNotifications(),
  activeToastIds: [],
  historyOpen: false,
  setHistoryOpen: (open) => set({ historyOpen: open }),
  _unlisten: null,
  _initialized: false,

  init: async () => {
    if (get()._initialized) return;
    set({ _initialized: true });
    const unlisten = await listenIfTauri<NotificationSentPayload>("notification-sent", (event) => {
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
      return {
        notifications: next,
        // ring 截断掉的旧通知同步移出栈，防止栈里挂着已不存在的 id
        activeToastIds: state.activeToastIds.filter((id) => next.some((n) => n.id === id)),
      };
    });
  },

  showToast: (id) => {
    set((state) => {
      if (state.activeToastIds.includes(id)) return state;
      const record = state.notifications.find((n) => n.id === id);
      if (!record) return state;
      const candidate = [id, ...state.activeToastIds];
      if (candidate.length <= MAX_ACTIVE_TOASTS) return { activeToastIds: candidate };
      // 超容：askInput 永远占位，从后往前挤掉第一个非 askInput 的旧卡
      const byId = new Map(state.notifications.map((n) => [n.id, n]));
      const isAskInput = (toastId: string) => {
        const n = byId.get(toastId);
        return n?.requiresInput === true || n?.kind === "waiting_input";
      };
      for (let i = candidate.length - 1; i >= 1; i--) {
        if (!isAskInput(candidate[i])) {
          candidate.splice(i, 1);
          return { activeToastIds: candidate };
        }
      }
      // 全是 askInput：挤掉最旧的一张（仍在历史与未读 badge 里）
      candidate.pop();
      return { activeToastIds: candidate };
    });
  },

  dismissToast: (id) => {
    set((state) => ({
      activeToastIds: state.activeToastIds.filter((toastId) => toastId !== id),
    }));
    get().markRead(id);
  },

  markRead: (id) => {
    set((state) => {
      const target = state.notifications.find((n) => n.id === id);
      if (!target || target.read) return state;
      const next = state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
      writeStoredNotifications(next);
      return { notifications: next };
    });
  },

  markAllRead: () => {
    set((state) => {
      if (state.notifications.every((n) => n.read)) return state;
      const next = state.notifications.map((n) => (n.read ? n : { ...n, read: true }));
      writeStoredNotifications(next);
      return { notifications: next };
    });
  },

  respond: async (id, text) => {
    const record = get().notifications.find((n) => n.id === id);
    if (!record) throw new Error("通知不存在");
    const sessionId = record.sessionId;
    if (!isNotificationSessionAlive(sessionId)) {
      throw new Error("会话已不存在，无法回传输入");
    }
    await terminalService.submitToSession(sessionId as string, text);
    set((state) => {
      const next = state.notifications.map((n) =>
        n.id === id ? { ...n, respondedAt: Date.now(), read: true } : n
      );
      writeStoredNotifications(next);
      return { notifications: next };
    });
  },

  clear: () => {
    writeStoredNotifications([]);
    set({ notifications: [], activeToastIds: [] });
  },
}));
