// `@Bot` / `@引擎` 提及的纯逻辑：补全匹配、插入用的 token、发送路由、给 Bot 的正文。
// 路由以补全时记下的结构化提及为准（名字可能含空格 / 中文，不从文本反推）；
// 只有在提及记录丢失时（例如重挂载前的旧草稿），才按已知 Bot 的 token 兜底识别开头的 `@token`。
import type { AcpEngineInfo, AgentChatAttachment } from "@/types/agentChat";
import type { BotSummary } from "@/types/bot";
import type { BotMention } from "@/stores/useBotAskStore";
import { isAbsolutePath, joinCwd } from "./chatPaths";

/** 插入草稿的 token：空白折成 `_`，去掉 `@`，保留中文等其余字符。 */
export function mentionToken(name: string): string {
  const token = name.trim().replace(/@/g, "").replace(/\s+/g, "_");
  return token || "bot";
}

function rank(name: string, query: string): number {
  const lower = name.toLowerCase();
  if (!query) return 1;
  if (lower.startsWith(query)) return 0;
  if (lower.includes(query)) return 1;
  return -1;
}

/** 多个候选名里最好的匹配等级；都不匹配返回 -1。 */
function bestRank(query: string, ...names: string[]): number {
  const ranks = names.map((name) => rank(name, query)).filter((value) => value >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : -1;
}

/** `@` 补全里的 Bot：名字不分大小写前缀优先、其次包含。自动 Bot 由引擎分组代表，不重复列；
 * 当前对话就是某个 Bot 的对话时不列它自己。 */
export function matchBots(bots: readonly BotSummary[], query: string, currentChatId: string, limit = 5): BotSummary[] {
  const needle = query.trim().toLowerCase();
  return bots
    .filter((bot) => !bot.autoCreated && bot.chatId !== currentChatId)
    .map((bot) => ({ bot, score: bestRank(needle, bot.name, mentionToken(bot.name)) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || a.bot.name.localeCompare(b.bot.name))
    .slice(0, limit)
    .map(({ bot }) => bot);
}

/** `@` 补全里的引擎：只列可用的，按 label / id 匹配。 */
export function matchEngines(engines: readonly AcpEngineInfo[], query: string, limit = 4): AcpEngineInfo[] {
  const needle = query.trim().toLowerCase();
  return engines
    .filter((engine) => engine.available)
    .map((engine) => ({ engine, score: bestRank(needle, engine.label, engine.id) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ engine }) => engine);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `@token` 作为独立词出现的位置（前面是开头或空白，后面是空白或结尾）；没有返回 -1。 */
export function findMention(text: string, token: string): number {
  const match = new RegExp(`(^|\\s)@${escapeRegExp(token)}(?=\\s|$)`).exec(text);
  return match ? match.index + match[1].length : -1;
}

export interface BotRoute {
  mention: BotMention;
  /** 去掉 `@token` 后交给 Bot 的正文。 */
  message: string;
}

function stripMention(text: string, index: number, token: string): string {
  return `${text.slice(0, index)}${text.slice(index + token.length + 1)}`.replace(/[ \t]{2,}/g, " ").trim();
}

/** 草稿该不该交给 Bot：取正文里最靠前的那个提及。 */
export function resolveBotRoute(
  text: string,
  mentions: readonly BotMention[],
  bots: readonly BotSummary[] | null,
): BotRoute | null {
  let best: { mention: BotMention; index: number } | null = null;
  for (const mention of mentions) {
    const index = findMention(text, mention.token);
    if (index >= 0 && (!best || index < best.index)) best = { mention, index };
  }
  if (!best && bots) {
    // 兜底：提及记录丢了，但草稿以某个手建 Bot 的 `@token` 开头。
    const leading = /^@(\S+)/.exec(text.trimStart());
    const bot = leading ? bots.find((item) => !item.autoCreated && mentionToken(item.name) === leading[1]) : undefined;
    if (bot) {
      const token = mentionToken(bot.name);
      best = { mention: { kind: "bot", token, botId: bot.id, name: bot.name }, index: findMention(text, token) };
    }
  }
  if (!best) return null;
  return { mention: best.mention, message: stripMention(text, best.index, best.mention.token) };
}

/** 发给当前会话时不该被当成文件引用的 `@token`（命中 Bot / 引擎的）。 */
export function mentionTokens(mentions: readonly BotMention[], bots: readonly BotSummary[] | null): Set<string> {
  const tokens = new Set(mentions.map((mention) => mention.token));
  for (const bot of bots ?? []) if (!bot.autoCreated) tokens.add(mentionToken(bot.name));
  return tokens;
}

/** 交给 Bot 的正文：Bot 的工作目录可能不同，相对 `@文件` 换成绝对路径；带路径的附件按行追加。
 * 无路径的图片 Bot 收不到（ask 只传文本），返回跳过的张数让界面提示。 */
export function buildBotAskText(
  message: string,
  attachments: readonly AgentChatAttachment[],
  cwd: string,
  keepTokens: ReadonlySet<string>,
): { text: string; skippedImages: number } {
  const absolute = (path: string) => (isAbsolutePath(path) || !cwd ? path : joinCwd(cwd, path));
  const body = message.replace(/(^|\s)@([^\s@]+)/g, (whole, lead: string, mention: string) =>
    keepTokens.has(mention) ? whole : `${lead}@${absolute(mention)}`,
  );
  const files = attachments.filter((item) => item.path).map((item) => `@${absolute(item.path ?? "")}`);
  const skippedImages = attachments.filter((item) => !item.path).length;
  return { text: [body, ...files].filter(Boolean).join("\n"), skippedImages };
}
