// Bot 联系人（Rust services/bot_service.rs 的镜像）。
import type { AcpChatPhase } from "./agentChat";

export const BOTS_CHANGED_EVENT = "bots-changed";
/** 窗口内 DOM 事件：联系人列表据此打开新建 Bot 对话框（桌宠「新建 Bot」入口）。 */
export const CREATE_BOT_DOM_EVENT = "ccpanes:create-bot";
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
  /** 对已配对的其他设备可见、可收远程消息（Bot 组网，docs/112 §5）。缺省 = true。 */
  remoteShared?: boolean;
  /** 远程消息开启的回合用哪一档权限。缺省 = ask_origin。 */
  remotePolicy?: RemotePolicy;
  /** allowlist 档自动放行的 ACP ToolKind。 */
  remoteAllowKinds?: string[];
  createdAt: number;
  updatedAt: number;
  /** Agent Chat「@引擎」自动创建的默认 Bot（同引擎同 cwd 复用一个）。 */
  autoCreated?: boolean;
  /** 桌宠形象（ccchan 皮肤 id）；缺省 = 桌宠设置里的默认角色。 */
  petId?: string | null;
}

/** 远程权限四档（Rust `bot_mesh::RemotePolicy`）。`full` = 最高权限，危险。 */
export type RemotePolicy = "deny" | "ask_origin" | "allowlist" | "full";
export const REMOTE_POLICIES: RemotePolicy[] = ["deny", "ask_origin", "allowlist", "full"];

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
    remoteShared: true,
    remotePolicy: "ask_origin",
    remoteAllowKinds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** `ask_bot` 的返回（Rust BotAskReply 镜像）。stopReason = "cancelled" 时正文可能是部分。 */
export interface BotAskReply {
  text: string;
  stopReason: string;
  botChatId: string;
}
