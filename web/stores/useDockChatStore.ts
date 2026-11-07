// 右侧面板里的 Agent 对话（Cursor 式侧栏聊天）。
//
// 对话本身和窗格里的 agent-chat 标签是同一套：会话真身在 Rust 的 AcpChatService，
// 消息流在 useAgentChatStore，都按 chatId 寻址。本 store 只记「面板里开着哪几个、
// 哪个在前面」，并持久化续接所需的 engineId/acpSessionId，重启后点开即自动续上。
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setPendingResume } from "@/components/agentchat/pendingResume";
import { agentChatService } from "@/services/agentChatService";
import { isTauriRuntime } from "@/services/runtime";
import { dropAgentChatState } from "@/stores/agentChatEvents";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";

export const DOCK_CHAT_STORAGE_KEY = "cc-panes-dock-chat";
/** 面板里同时开着的对话上限；超出时关掉最久没看的那个（它仍在历史里可续接）。 */
export const MAX_DOCK_CHATS = 5;
const ID_PREFIX = "dock-chat-";

export type DockChatHistoryTab = "chat" | "terminal";

export interface DockChatEntry {
  id: string;
  /** 新建时为空：标题取第一条用户消息；续接时取历史标题。 */
  title: string;
  /** 新建时的项目目录；对话中途切目录走 useAgentChatStore.cwdOverride。 */
  cwd: string | null;
  engineId?: string;
  acpSessionId?: string;
  /** 最近一次被切到前面的时间，决定超限时关哪个。 */
  lastViewedAt: number;
}

interface DockChatState {
  chats: DockChatEntry[];
  activeId: string | null;
  historyOpen: boolean;
  historyTab: DockChatHistoryTab;
  newChat: (cwd: string | null) => string;
  select: (id: string) => void;
  close: (id: string) => void;
  /** 移到窗格：只从面板摘掉，不停会话（窗格标签会接管同一个 chatId）。 */
  detach: (id: string) => void;
  resume: (entry: AcpChatHistoryEntry) => string;
  syncSession: (id: string, patch: Partial<Pick<DockChatEntry, "title" | "engineId" | "acpSessionId">>) => void;
  openHistory: (tab?: DockChatHistoryTab) => void;
  closeHistory: () => void;
}

export function isDockChatId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

let lastTick = 0;
/** 单调递增的「查看时间」：同一毫秒里连续操作也分得出先后，超限时才挤得对。 */
function viewTick(): number {
  lastTick = Math.max(Date.now(), lastTick + 1);
  return lastTick;
}

function newId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${ID_PREFIX}${random}`;
}

/** 与窗格 agent-chat 标签关闭时同口径：回收渲染态并停掉后端进程（后端幂等）。 */
function stopChat(id: string): void {
  dropAgentChatState(id);
  if (!isTauriRuntime()) return;
  void Promise.resolve(agentChatService.stop(id)).catch((error) => {
    handleErrorSilent(error, "stop dock chat session");
  });
}

/** 加入一条后裁到上限：保留当前这条，其余按最近查看排序，挤掉最旧的。 */
function withCapacity(chats: DockChatEntry[], keepId: string): { kept: DockChatEntry[]; evicted: DockChatEntry[] } {
  if (chats.length <= MAX_DOCK_CHATS) return { kept: chats, evicted: [] };
  const evictable = chats
    .filter((chat) => chat.id !== keepId)
    .sort((a, b) => a.lastViewedAt - b.lastViewedAt);
  const evicted = evictable.slice(0, chats.length - MAX_DOCK_CHATS);
  const evictedIds = new Set(evicted.map((chat) => chat.id));
  return { kept: chats.filter((chat) => !evictedIds.has(chat.id)), evicted };
}

function neighborOf(chats: DockChatEntry[], id: string): string | null {
  const index = chats.findIndex((chat) => chat.id === id);
  if (index < 0) return chats[0]?.id ?? null;
  return chats[index + 1]?.id ?? chats[index - 1]?.id ?? null;
}

/** 已有对话真正开聊后才可能续接；还停在引擎选择页的不登记续接意图。 */
function armResume(chat: DockChatEntry): void {
  if (!chat.engineId || !chat.acpSessionId || !chat.cwd) return;
  if (useAgentChatStore.getState().chats[chat.id]?.snapshot) return;
  setPendingResume(chat.id, { engineId: chat.engineId, cwd: chat.cwd, acpSessionId: chat.acpSessionId });
}

export const useDockChatStore = create<DockChatState>()(
  persist(
    (set, get) => {
      const add = (entry: DockChatEntry) => {
        const { kept, evicted } = withCapacity([...get().chats, entry], entry.id);
        set({ chats: kept, activeId: entry.id, historyOpen: false });
        evicted.forEach((chat) => stopChat(chat.id));
      };
      return {
        chats: [],
        activeId: null,
        historyOpen: false,
        historyTab: "chat",
        newChat: (cwd) => {
          const id = newId();
          add({ id, title: "", cwd, lastViewedAt: viewTick() });
          return id;
        },
        select: (id) => {
          const target = get().chats.find((chat) => chat.id === id);
          if (!target) return;
          armResume(target);
          set((state) => ({
            activeId: id,
            historyOpen: false,
            chats: state.chats.map((chat) => (chat.id === id ? { ...chat, lastViewedAt: viewTick() } : chat)),
          }));
        },
        close: (id) => {
          const { chats, activeId } = get();
          if (!chats.some((chat) => chat.id === id)) return;
          set({
            chats: chats.filter((chat) => chat.id !== id),
            activeId: activeId === id ? neighborOf(chats, id) : activeId,
          });
          stopChat(id);
        },
        detach: (id) => {
          const { chats, activeId } = get();
          set({
            chats: chats.filter((chat) => chat.id !== id),
            activeId: activeId === id ? neighborOf(chats, id) : activeId,
          });
        },
        resume: (entry) => {
          const open = get().chats.find((chat) => chat.acpSessionId === entry.acpSessionId);
          if (open) {
            get().select(open.id);
            return open.id;
          }
          const id = newId();
          setPendingResume(id, { engineId: entry.engineId, cwd: entry.cwd, acpSessionId: entry.acpSessionId });
          add({
            id,
            title: entry.title,
            cwd: entry.cwd,
            engineId: entry.engineId,
            acpSessionId: entry.acpSessionId,
            lastViewedAt: viewTick(),
          });
          return id;
        },
        syncSession: (id, patch) => {
          const current = get().chats.find((chat) => chat.id === id);
          if (!current) return;
          const changed = (Object.keys(patch) as (keyof typeof patch)[])
            .some((key) => patch[key] !== undefined && patch[key] !== current[key]);
          if (!changed) return;
          set((state) => ({
            chats: state.chats.map((chat) => (chat.id === id
              ? {
                ...chat,
                ...(patch.title ? { title: patch.title } : {}),
                ...(patch.engineId ? { engineId: patch.engineId } : {}),
                ...(patch.acpSessionId ? { acpSessionId: patch.acpSessionId } : {}),
              }
              : chat)),
          }));
        },
        openHistory: (tab) => set((state) => ({ historyOpen: true, historyTab: tab ?? state.historyTab })),
        closeHistory: () => set({ historyOpen: false }),
      };
    },
    {
      name: DOCK_CHAT_STORAGE_KEY,
      partialize: (state) => ({ chats: state.chats, activeId: state.activeId, historyTab: state.historyTab }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<DockChatState>;
        const chats = Array.isArray(persisted.chats)
          ? persisted.chats
            .filter((chat): chat is DockChatEntry => Boolean(chat) && typeof chat.id === "string" && isDockChatId(chat.id))
            .slice(0, MAX_DOCK_CHATS)
          : [];
        const activeId = chats.some((chat) => chat.id === persisted.activeId)
          ? persisted.activeId ?? null
          : chats[0]?.id ?? null;
        return {
          ...currentState,
          chats,
          activeId,
          historyTab: persisted.historyTab === "terminal" ? "terminal" : "chat",
        };
      },
      onRehydrateStorage: () => (state) => {
        // 重启后进程都不在了：给每条开过聊的对话登记续接，挂载时 EnginePicker 自动续上。
        state?.chats.forEach(armResume);
      },
    },
  ),
);
