// 侧栏会话卡的纯展示规则：标题回退、项目头像缩写/配色、引擎序列、时间。
// 与渲染解耦，便于单测锁住「同一项目永远同一个头像」与标题优先级。

/** 卡片标题的输入：与 WorkspaceTerminalRow 的命名字段同形（chat 行也复用）。 */
export interface SessionTitleSource {
  /** 标签标题（最终兜底） */
  title: string;
  /** 用户手动重命名过标签：直接用 title */
  titleRenamed: boolean;
  /** 提炼标题（Claude custom-title/agent-name/ai-title、Codex thread name、chat 历史标题） */
  sessionTitle: string | null;
  /** 第一条用户提问 */
  firstPrompt: string | null;
}

export type SessionTitleKind = "renamed" | "sessionTitle" | "firstPrompt" | "tabTitle";

/** 单行展示用：折叠换行与连续空白（首条提问常带多行粘贴内容）。 */
function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** 标题规则：手动重命名 > 提炼标题 > 第一条用户提问 > 标签标题。 */
export function resolveSessionTitle(source: SessionTitleSource): { text: string; kind: SessionTitleKind } {
  if (source.titleRenamed && oneLine(source.title)) return { text: oneLine(source.title), kind: "renamed" };
  const sessionTitle = oneLine(source.sessionTitle);
  if (sessionTitle) return { text: sessionTitle, kind: "sessionTitle" };
  const firstPrompt = oneLine(source.firstPrompt);
  if (firstPrompt) return { text: firstPrompt, kind: "firstPrompt" };
  return { text: oneLine(source.title) || source.title, kind: "tabTitle" };
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

/**
 * 项目头像缩写（最多两个字符，大写）：
 * - 中日韩名取首字（方块里放两个汉字太挤）；
 * - 首段带数字取「首字母 + 首个数字」：sub2api-product → S2；
 * - 多段取前两段首字母：cc-pane → CP；
 * - 单段驼峰取前两个大写字母：WeChatBot → WC；否则取前两个字符：vms → VM。
 */
export function projectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = [...trimmed][0];
  if (CJK.test(first)) return first;
  const segments = trimmed.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (segments.length === 0) return first.toUpperCase();
  const head = segments[0];
  const digit = head.slice(1).match(/\p{N}/u)?.[0];
  if (digit) return `${head[0]}${digit}`.toUpperCase();
  if (segments.length >= 2) return `${head[0]}${segments[1][0]}`.toUpperCase();
  const humps = head.match(/\p{Lu}/gu);
  if (humps && humps.length >= 2) return `${humps[0]}${humps[1]}`;
  return [...head].slice(0, 2).join("").toUpperCase();
}

/** 头像底色候选：--app-tag-* 色板去掉灰（灰与「空闲」态混淆）。深浅主题各自有一套值。 */
export const PROJECT_AVATAR_TOKENS = [
  "--app-tag-blue",
  "--app-tag-green",
  "--app-tag-purple",
  "--app-tag-amber",
  "--app-tag-pink",
  "--app-tag-cyan",
  "--app-tag-red",
] as const;

/** FNV-1a 32 位：跨会话、跨机器稳定（不能用 Math.random / 对象身份）。 */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 按项目名稳定取一个品牌色 token 名（大小写/首尾空白不影响结果）。 */
export function projectAvatarToken(name: string): (typeof PROJECT_AVATAR_TOKENS)[number] {
  const key = name.trim().toLowerCase();
  return PROJECT_AVATAR_TOKENS[stableHash(key) % PROJECT_AVATAR_TOKENS.length];
}

/**
 * 引擎序列去重：同一引擎只留最后一次出现，保持「最近的在右」。
 * [claude, codex, claude] → [codex, claude]。空值丢弃。
 */
export function engineSequence(engines: readonly (string | null | undefined)[]): string[] {
  const result: string[] = [];
  for (const engine of engines) {
    const id = engine?.trim();
    if (!id) continue;
    const existing = result.indexOf(id);
    if (existing >= 0) result.splice(existing, 1);
    result.push(id);
  }
  return result;
}

/** 毫秒/秒时间戳归一到毫秒（chat 历史的时间字段单位不一）；无效值返回 null。 */
export function normalizeEpochMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

/** 紧凑相对时间：刚刚 / 5m / 3h / 2d / 超过一周给日期。语言无关，窄侧栏放得下。 */
export function compactRelativeTime(epochMs: number, now: number, justNow: string): string {
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (seconds < 60) return justNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(epochMs);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
