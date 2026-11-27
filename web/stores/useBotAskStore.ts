// Agent Chat 里的 `@Bot`：在途 / 已完成的委托卡片、输入框里记下的结构化提及、
// 以及补全用的 Bot / 引擎目录。只在内存里（切标签保持，刷新后丢失）。
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { AcpEngineInfo } from "@/types/agentChat";
import type { BotSummary } from "@/types/bot";

export type BotAskStatus = "running" | "done" | "failed" | "cancelled";

/** 补全选中时记下的提及：草稿里是 `@token`，发送时按它路由，不靠正则反推名字。 */
export type BotMention =
  | { kind: "bot"; token: string; botId: string; name: string }
  | { kind: "engine"; token: string; engineId: string; name: string };

export interface BotAskTarget {
  name: string;
  avatar: string;
  color: string;
}

export interface BotAsk {
  id: string;
  fromChatId: string;
  /** 交给 Bot 的正文（不含 `@token`）。 */
  text: string;
  target: BotAskTarget;
  /** 「@引擎」先要找到 / 建好默认 Bot，之前为 null。 */
  botId: string | null;
  status: BotAskStatus;
  /** Bot 已接下本条（见到它的 external_prompt 公告）。 */
  admitted: boolean;
  cancelRequested: boolean;
  reply?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface BotAskState {
  asks: Record<string, BotAsk>;
  /** 来源对话 → 卡片 id（按发起顺序）。 */
  byChat: Record<string, string[]>;
  mentions: Record<string, BotMention[]>;
  /** null = 还没加载过。 */
  bots: BotSummary[] | null;
  engines: AcpEngineInfo[] | null;
  start: (ask: Omit<BotAsk, "status" | "admitted" | "cancelRequested" | "startedAt">) => void;
  bindBot: (askId: string, botId: string, target?: BotAskTarget) => void;
  markAdmitted: (askId: string) => void;
  requestCancel: (askId: string) => void;
  finish: (askId: string, reply: string, cancelled: boolean) => void;
  fail: (askId: string, error: string) => void;
  dismiss: (askId: string) => void;
  addMention: (chatId: string, mention: BotMention) => void;
  clearMentions: (chatId: string) => void;
  setBots: (bots: BotSummary[]) => void;
  setEngines: (engines: AcpEngineInfo[]) => void;
}

export const useBotAskStore = create<BotAskState>()(
  immer((set) => ({
    asks: {},
    byChat: {},
    mentions: {},
    bots: null,
    engines: null,

    start: (ask) =>
      set((state) => {
        state.asks[ask.id] = { ...ask, status: "running", admitted: false, cancelRequested: false, startedAt: Date.now() };
        (state.byChat[ask.fromChatId] ??= []).push(ask.id);
      }),

    bindBot: (askId, botId, target) =>
      set((state) => {
        const ask = state.asks[askId];
        if (!ask) return;
        ask.botId = botId;
        if (target) ask.target = target;
      }),

    markAdmitted: (askId) =>
      set((state) => {
        const ask = state.asks[askId];
        if (ask && ask.status === "running") ask.admitted = true;
      }),

    requestCancel: (askId) =>
      set((state) => {
        const ask = state.asks[askId];
        if (ask && ask.status === "running") ask.cancelRequested = true;
      }),

    finish: (askId, reply, cancelled) =>
      set((state) => {
        const ask = state.asks[askId];
        if (!ask || ask.status !== "running") return;
        ask.status = cancelled ? "cancelled" : "done";
        ask.reply = reply;
        ask.finishedAt = Date.now();
      }),

    fail: (askId, error) =>
      set((state) => {
        const ask = state.asks[askId];
        if (!ask || ask.status !== "running") return;
        ask.status = "failed";
        ask.error = error;
        ask.finishedAt = Date.now();
      }),

    dismiss: (askId) =>
      set((state) => {
        const ask = state.asks[askId];
        if (!ask) return;
        delete state.asks[askId];
        const ids = state.byChat[ask.fromChatId];
        if (!ids) return;
        const next = ids.filter((id) => id !== askId);
        if (next.length > 0) state.byChat[ask.fromChatId] = next;
        else delete state.byChat[ask.fromChatId];
      }),

    addMention: (chatId, mention) =>
      set((state) => {
        const list = (state.mentions[chatId] ??= []);
        if (!list.some((item) => item.token === mention.token)) list.push(mention);
      }),

    clearMentions: (chatId) =>
      set((state) => {
        delete state.mentions[chatId];
      }),

    setBots: (bots) =>
      set((state) => {
        state.bots = bots;
      }),

    setEngines: (engines) =>
      set((state) => {
        state.engines = engines;
      }),
  })),
);

const EMPTY_IDS: readonly string[] = [];
const EMPTY_MENTIONS: readonly BotMention[] = [];

/** selector 用：返回稳定引用（缺省时共享空数组，避免每次渲染新集合）。 */
export const selectAskIds = (chatId: string) => (state: BotAskState): readonly string[] =>
  state.byChat[chatId] ?? EMPTY_IDS;
export const selectMentions = (chatId: string) => (state: BotAskState): readonly BotMention[] =>
  state.mentions[chatId] ?? EMPTY_MENTIONS;
