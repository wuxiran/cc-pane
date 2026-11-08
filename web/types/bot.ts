// Bot 联系人（Rust services/bot_service.rs 的镜像）。
import type { AcpChatPhase } from "./agentChat";

export const BOTS_CHANGED_EVENT = "bots-changed";
/** Bot 的会话 chatId = 标签 id = `bot-{id}`。 */
export const BOT_CHAT_PREFIX = "bot-";

export interface Bot {
  id: string;
  name: string;
  /** 单个 emoji；空 = 用名字首字。 */
  avatar: string;
  color: string;
  persona: string;
  engineId: string;
  /** 绑定项目目录；缺省 = Bot 自己的家目录（人设写在 CLAUDE.md / AGENTS.md）。 */
  cwd?: string | null;
  autoApproveKinds: string[];
  acpSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BotSummary extends Bot {
  chatId: string;
  effectiveCwd: string;
  phase?: AcpChatPhase;
}

export function botChatId(botId: string): string {
  return `${BOT_CHAT_PREFIX}${botId}`;
}

/** 标签 / chatId 是否属于某个 Bot；是则返回 botId。 */
export function botIdOfChat(chatId: string | undefined | null): string | null {
  if (!chatId || !chatId.startsWith(BOT_CHAT_PREFIX)) return null;
  const id = chatId.slice(BOT_CHAT_PREFIX.length);
  return id ? id : null;
}

export function emptyBot(engineId: string): Bot {
  return {
    id: "",
    name: "",
    avatar: "🤖",
    color: "#6366f1",
    persona: "",
    engineId,
    cwd: null,
    autoApproveKinds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}
