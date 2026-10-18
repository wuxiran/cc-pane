import { Bot, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { devDebugLog } from "@/utils/devLogger";
import type { CCChanSettings } from "./types";
type AiEngine = CCChanSettings["aiEngine"];
export type ChatRole = "assistant" | "system" | "user";
export interface ChatMessage { id: string; role: ChatRole; content: string; createdAt: number; }
export const ENGINE_OPTIONS: Array<{ value: AiEngine; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

export const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 16_000;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATURAL_TEXT_PATTERN = /[\p{Script=Han}A-Za-z]{2,}/u;
const CJK_PATTERN = /[\p{Script=Han}]/u;
const TERMINAL_CHROME_COMPACT_MARKERS = [
  "tipsforgettingstarted",
  "welcomeback",
  "run/inittocreateaclaude.md",
  "otel_resource_attributes",
  "claudeagents",
  "/mcpnowcollapses",
  "apiusagebilling",
  "/release-notes",
  "1mcontext",
  "high/effort",
  "higheffort",
  "thinkingwithhigheffort",
  "thoughtfor",
  "mulling",
  "setupissue",
  "/doctor",
  "bypasspermissionson",
  "tokenusage",
  "contextleft",
  "cc-panes-dev\\ccchan",
];

function createMessageId(role: ChatRole): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createChatMessage(role: ChatRole, content: string): ChatMessage {
  return {
    id: createMessageId(role),
    role,
    content,
    createdAt: Date.now(),
  };
}

function applyBackspaces(value: string): string {
  let next = value;
  while (/[^\n]\x08/.test(next)) {
    next = next.replace(/[^\n]\x08/g, "");
  }
  return next.replace(/\x08/g, "");
}

function isTerminalChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (UUID_PATTERN.test(trimmed)) return true;
  const compact = compactTerminalChromeText(trimmed);
  if (TERMINAL_CHROME_COMPACT_MARKERS.some((marker) => compact.includes(marker))) {
    return true;
  }
  if (isClaudeProgressLine(trimmed, compact)) return true;
  const withoutFrameChars = trimmed.replace(/[│┃╭╮╰╯┌┐└┘─═━┄┈╼╾]/g, "").trim();
  if (!withoutFrameChars) return true;
  if (/^[>›∙•·*_\-\s]+$/.test(trimmed)) return true;
  if (/^(saut[ée]ed|cogitated|thinking|working|running|press|enter|esc|tab|shift\+tab|ctrl\+c|creating)\b/i.test(trimmed)) {
    return true;
  }
  if (/bypass\s*permissions\s*on|bypasspermissionson|for agents|token usage|context left|high\/effort|esc\s*interrupt/i.test(trimmed)) {
    return true;
  }
  if (/\b\d+\s*tokens?\b/i.test(trimmed) && /Claude Code|Codex|context|effort/i.test(trimmed)) {
    return true;
  }
  const alphaNum = (trimmed.match(/[A-Za-z0-9\p{Script=Han}]/gu) ?? []).length;
  const symbols = (trimmed.match(/[^\sA-Za-z0-9\p{Script=Han}，。！？、；：,.!?;:'"()[\]{}<>/\\|-]/gu) ?? []).length;
  if (symbols > alphaNum && !CJK_PATTERN.test(trimmed)) return true;
  return false;
}

function isClaudeProgressLine(line: string, compact: string): boolean {
  if (/mulling|thinking with high effort|thought for \d+s|setup issue/i.test(line)) {
    return true;
  }
  if (compact.includes("thinking") && compact.includes("effort")) {
    return true;
  }
  if (compact.includes("mulling") || compact.includes("thoughtfor")) {
    return true;
  }
  return false;
}

function compactTerminalChromeText(line: string): string {
  return line
    .toLocaleLowerCase()
    .replace(/[│┃╭╮╰╯┌┐└┘─═━┄┈╼╾|`'"()[\]{}<>\s·•∙▷▶▸▹▾▿●◆◇■□▪▫*+↓↑…!⚠]+/g, "");
}

function firstNaturalTextIndex(line: string): number {
  const compactChromeMarkers = [
    "用户",
    "系统",
    "我是",
    "我可以",
    "我能",
    "看起来",
    "这",
    "你",
    "错误",
    "失败",
    "无法",
    "The ",
    "I ",
    "It ",
    "You ",
    "Looks ",
    "Error",
    "Failed",
    "Cannot",
  ];
  const indexes = compactChromeMarkers
    .map((marker) => line.indexOf(marker))
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function stripInlineTerminalChrome(line: string): string {
  let next = line
    .replace(/\(B\s*0;?/g, " ")
    .replace(/[▷▶▸▹▾▿●◆◇■□▪▫]+/g, " ")
    .replace(/\b(?:Claude Code|Codex)\s*[>›]?\s*/gi, " ")
    .replace(/\bbypass\s*permissions\s*on\b/gi, " ")
    .replace(/\bbypasspermissionson\b/gi, " ")
    .replace(/\bshift\+?tab\s*to\s*cycle\b/gi, " ")
    .replace(/\bshift\+?tabtocycle\b/gi, " ")
    .replace(/\besc\s*interrupt\b/gi, " ")
    .replace(/\bhigh\/effort\b/gi, " ")
    .replace(/\bcreating\.{0,3}\b/gi, " ")
    .replace(/\b\d+\s*tokens?\b/gi, " ")
    .replace(/\.\.\.\s*\(\d+s\s*·[^)]*\)/gi, " ");

  const naturalIndex = firstNaturalTextIndex(next);
  if (naturalIndex > 0 && /Claude Code|Codex|bypass|tokens?|effort|Creating/i.test(next.slice(0, naturalIndex))) {
    next = next.slice(naturalIndex);
  }

  return next.replace(/[ \t]{2,}/g, " ").trim();
}

export function cleanupTerminalOutput(raw: string): string {
  const withoutAnsi = raw.replace(ANSI_PATTERN, "");
  const normalized = applyBackspaces(withoutAnsi)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_PATTERN, "")
    .replace(/\uFFFD/g, "");
  const lines = normalized
    .split("\n")
    .map((line) => stripInlineTerminalChrome(line.trimEnd()))
    .filter((line) => !isTerminalChromeLine(line))
    .filter((line) => NATURAL_TEXT_PATTERN.test(line));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatAssistantContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return content;
  try {
    const parsed = JSON.parse(trimmed);
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    return content;
  }
}

function trimMessageContent(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  return `...${content.slice(content.length - MAX_MESSAGE_CHARS)}`;
}

export function debugCCChanChat(event: string, payload: Record<string, unknown> = {}): void {
  devDebugLog("ccchan-chat-debug", event, payload);
}

export function appendCleanAssistantMessage(current: ChatMessage[], text: string): ChatMessage[] {
  if (!text) return current;

  const next = [...current];
  const last = next[next.length - 1];
  if (last?.role === "assistant") {
    const trimmedText = text.trim();
    const existing = last.content.trim();
    if (!trimmedText || existing.endsWith(trimmedText) || existing.includes(trimmedText)) {
      return current;
    }
    const merged = trimmedText.startsWith(existing)
      ? trimmedText
      : `${last.content}${last.content.endsWith("\n") ? "" : "\n"}${text}`;
    next[next.length - 1] = { ...last, content: trimMessageContent(merged) };
    return next.slice(-MAX_MESSAGES);
  }

  return [
    ...next,
    createChatMessage("assistant", trimMessageContent(text)),
  ].slice(-MAX_MESSAGES);
}

export function engineLabel(engine: AiEngine): string {
  return ENGINE_OPTIONS.find((option) => option.value === engine)?.label ?? engine;
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center px-2 py-1">
        <div
          className="max-w-[88%] rounded-md border px-2.5 py-1 text-center text-[11px] leading-4"
          style={{
            borderColor: "#cbd5e1",
            background: "#f8fafc",
            color: "#475569",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  return (
    <div className={`flex w-full gap-2 px-2 py-1.5 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: "#dbeafe", color: "#2563eb" }}
        >
          <Bot size={14} />
        </div>
      )}
      <div
        className="max-w-[82%] rounded-md px-3 py-2 text-[12.5px] leading-5 shadow-sm"
        style={{
          borderTopLeftRadius: isUser ? 8 : 2,
          borderTopRightRadius: isUser ? 2 : 8,
          background: isUser ? "#2563eb" : "#ffffff",
          color: isUser ? "#ffffff" : "#0f172a",
          border: isUser ? "1px solid #1d4ed8" : "1px solid #dbeafe",
        }}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="ccchan-markdown min-w-0 break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatAssistantContent(message.content)}</ReactMarkdown>
          </div>
        )}
      </div>
      {isUser && (
        <div
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: "#e2e8f0", color: "#334155" }}
        >
          <User size={14} />
        </div>
      )}
    </div>
  );
}

