import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Bot, ChevronDown, Loader2, Maximize2, RefreshCw, Send, Square, User, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { getErrorMessage } from "@/utils";
import { devDebugLog } from "@/utils/devLogger";
import type { CCChanChatOutputPayload, CCChanChatStatusPayload, CCChanSettings, TerminalOutputPayload } from "./types";

type AiEngine = CCChanSettings["aiEngine"];
export type ChatRole = "assistant" | "system" | "user";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

interface ChatPanelProps {
  settings: CCChanSettings;
  sessionId: string | null;
  messages: ChatMessage[];
  onMessagesChange: Dispatch<SetStateAction<ChatMessage[]>>;
  onSessionIdChange: (sessionId: string | null) => void;
  onClose: () => void;
  /** 面板尺寸（随宠物 petSize 缩放，由 ccchanLayout 计算），默认历史值。 */
  width?: number;
  height?: number;
}

interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

const ENGINE_OPTIONS: Array<{ value: AiEngine; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

const MAX_MESSAGES = 80;
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

function createChatMessage(role: ChatRole, content: string): ChatMessage {
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

function debugCCChanChat(event: string, payload: Record<string, unknown> = {}): void {
  devDebugLog("ccchan-chat-debug", event, payload);
}

function appendCleanAssistantMessage(current: ChatMessage[], text: string): ChatMessage[] {
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

function engineLabel(engine: AiEngine): string {
  return ENGINE_OPTIONS.find((option) => option.value === engine)?.label ?? engine;
}

function MessageBubble({ message }: { message: ChatMessage }) {
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

export function ChatPanel({
  settings,
  sessionId,
  messages,
  onMessagesChange,
  onSessionIdChange,
  onClose,
  width = 432,
  height = 508,
}: ChatPanelProps) {
  const { t } = useTranslation("ccchan"); const saveSettings = useCCChanStore((state) => state.saveSettings);
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [switchingEngine, setSwitchingEngine] = useState<AiEngine | null>(null);
  const [restartRequestId, setRestartRequestId] = useState(0);
  const [checkingSession, setCheckingSession] = useState(false);
  const [autoStartPaused, setAutoStartPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const startingRef = useRef(false);
  const hasSubmittedRef = useRef(false);
  const ignoredStartupOutputLoggedRef = useRef(false);
  const verifiedSessionRef = useRef<string | null>(null);
  const setMessages = onMessagesChange;
  const controlsDisabled = starting || sending || restarting || checkingSession || Boolean(switchingEngine);
  const inputDisabled = controlsDisabled || autoStartPaused;
  const activeEngineLabel = useMemo(() => engineLabel(settings.aiEngine), [settings.aiEngine]);
  const activityLabel = restarting
    ? t("chat.activityRefreshing", { engine: activeEngineLabel })
    : checkingSession
      ? t("chat.activityChecking")
      : starting
        ? t("chat.activityStarting")
        : sending
          ? t("chat.activityWaiting")
          : null;

  useEffect(() => {
    if (!sessionId) {
      verifiedSessionRef.current = null;
      return;
    }
    if (verifiedSessionRef.current === sessionId) return;

    let cancelled = false;
    setCheckingSession(true);
    debugCCChanChat("session.check.begin", {
      sessionId,
    });

    invoke<boolean>("is_ccchan_chat_session_alive", { sessionId })
      .then((alive) => {
        if (cancelled) return;
        verifiedSessionRef.current = sessionId;
        debugCCChanChat("session.check.end", {
          sessionId,
          alive,
        });
        if (!alive) {
          hasSubmittedRef.current = false;
          ignoredStartupOutputLoggedRef.current = false;
          setAutoStartPaused(false);
          setError(null);
          setMessages((current) => [
            ...current,
            createChatMessage("system", t("chat.sessionInvalid")),
          ].slice(-MAX_MESSAGES));
          onSessionIdChange(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = getErrorMessage(err);
        debugCCChanChat("session.check.fail", {
          sessionId,
          error: message,
          rawError: err,
        });
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });

    return () => {
      cancelled = true;
    };
    // t 不进 deps：切语言会换 t 的 identity，重跑该 effect 会打断在途的会话 bootstrap
    // （cleanup 置 cancelled=true → setStarting(false) 被跳过 → 控件永久禁用 + CLI 进程成孤儿）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSessionIdChange, sessionId]);

  useEffect(() => {
    let cancelled = false;

    async function ensureSession() {
      if (autoStartPaused || checkingSession || sessionId || startingRef.current || switchingEngine) {
        debugCCChanChat("session.ensure.skip", {
          autoStartPaused,
          checkingSession,
          hasSession: Boolean(sessionId),
          starting: startingRef.current,
          switchingEngine: switchingEngine ?? null,
        });
        return;
      }
      startingRef.current = true;
      setStarting(true);
      setError(null);
      ignoredStartupOutputLoggedRef.current = false;
      debugCCChanChat("session.start.begin", {
        aiEngine: settings.aiEngine,
      });
      setMessages([
        createChatMessage("system", t("chat.sessionStarting", { engine: engineLabel(settings.aiEngine) })),
      ]);
      try {
        const nextSessionId = await invoke<string>("start_ccchan_chat", { aiEngine: settings.aiEngine });
        if (!cancelled) {
          setAutoStartPaused(false);
          onSessionIdChange(nextSessionId);
          setMessages((current) => [
            ...current,
            createChatMessage("system", t("chat.sessionConnected", { engine: engineLabel(settings.aiEngine) })),
          ].slice(-MAX_MESSAGES));
        }
        debugCCChanChat("session.start.end", {
          aiEngine: settings.aiEngine,
          sessionId: nextSessionId,
          cancelled,
        });
      } catch (err) {
        const message = getErrorMessage(err);
        debugCCChanChat("session.start.fail", {
          aiEngine: settings.aiEngine,
          error: message,
          rawError: err,
          cancelled,
        });
        if (!cancelled) {
          setError(message);
          setMessages((current) => [
            ...current,
            createChatMessage("system", t("chat.sessionStartFailed", { error: message })),
          ].slice(-MAX_MESSAGES));
        }
      } finally {
        startingRef.current = false;
        if (!cancelled) {
          setStarting(false);
          setRestarting(false);
        }
      }
    }

    void ensureSession();
    return () => {
      cancelled = true;
    };
    // t 不进 deps：切语言会换 t 的 identity，重跑该 effect 会打断在途的会话 bootstrap
    // （cleanup 置 cancelled=true → setStarting(false) 被跳过 → 控件永久禁用 + CLI 进程成孤儿）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartPaused, checkingSession, onSessionIdChange, restartRequestId, sessionId, settings.aiEngine, switchingEngine]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    async function attachStructuredOutput() {
      const webview = getCurrentWebview();
      const unlistenOutput = await webview.listen<CCChanChatOutputPayload>("ccchan-chat-output", (event) => {
        if (event.payload.sessionId !== sessionId) return;
        if (event.payload.role !== "assistant" || !event.payload.text) return;
        debugCCChanChat("structured.output", {
          sessionId,
          textLength: event.payload.text.length,
        });
        setMessages((current) => appendCleanAssistantMessage(current, event.payload.text));
      });
      const unlistenStatus = await webview.listen<CCChanChatStatusPayload>("ccchan-chat-status", (event) => {
        if (event.payload.sessionId !== sessionId) return;
        debugCCChanChat("structured.status", {
          sessionId,
          status: event.payload.status,
          message: event.payload.message ?? null,
        });

        if (event.payload.status === "starting" || event.payload.status === "thinking") {
          setSending(true);
          return;
        }
        if (event.payload.status === "ready") {
          setSending(false);
          setRestarting(false);
          return;
        }
        if (event.payload.status === "error") {
          const message = event.payload.message ?? t("chat.cliReturnedError", { engine: engineLabel(settings.aiEngine) });
          setSending(false);
          setRestarting(false);
          setError(message);
          return;
        }
        if (event.payload.status === "exited") {
          const message = event.payload.message ?? t("chat.cliExited", { engine: engineLabel(settings.aiEngine) });
          startingRef.current = false;
          hasSubmittedRef.current = false;
          setStarting(false);
          setSending(false);
          setRestarting(false);
          setAutoStartPaused(true);
          setError(message);
          setMessages((current) => [
            ...current,
            createChatMessage("system", message),
          ].slice(-MAX_MESSAGES));
          onSessionIdChange(null);
        }
      });

      unlisten = () => {
        unlistenOutput();
        unlistenStatus();
      };
    }

    if (sessionId) {
      attachStructuredOutput().catch((err) => {
        const message = getErrorMessage(err);
        debugCCChanChat("structured.attach.fail", {
          sessionId,
          error: message,
          rawError: err,
          cancelled,
        });
        if (!cancelled) setError(message);
      });
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // t 不进 deps：切语言会换 t 的 identity，重跑该 effect 会打断在途的会话 bootstrap
    // （cleanup 置 cancelled=true → setStarting(false) 被跳过 → 控件永久禁用 + CLI 进程成孤儿）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSessionIdChange, sessionId, settings.aiEngine]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    async function attachOutput() {
      debugCCChanChat("output.attach.begin", {
        sessionId,
      });
      unlisten = await getCurrentWebview().listen<TerminalOutputPayload>("terminal-output", (event) => {
        if (event.payload.sessionId !== sessionId) return;
        const cleaned = cleanupTerminalOutput(event.payload.data);
        if (!hasSubmittedRef.current) {
          if (!ignoredStartupOutputLoggedRef.current) {
            ignoredStartupOutputLoggedRef.current = true;
            debugCCChanChat("output.skip.before-user-message", {
              sessionId,
              rawLength: event.payload.data.length,
              cleanedLength: cleaned.length,
            });
          }
          return;
        }
        debugCCChanChat("output.chunk", {
          sessionId,
          rawLength: event.payload.data.length,
          cleanedLength: cleaned.length,
          accepted: cleaned.length > 0,
        });
        setMessages((current) => appendCleanAssistantMessage(current, cleaned));
      });
      debugCCChanChat("output.attach.end", {
        sessionId,
      });
    }

    if (sessionId) {
      attachOutput().catch((err) => {
        const message = getErrorMessage(err);
        debugCCChanChat("output.attach.fail", {
          sessionId,
          error: message,
          rawError: err,
          cancelled,
        });
        if (!cancelled) setError(message);
      });
    }

    return () => {
      cancelled = true;
      if (sessionId) {
        debugCCChanChat("output.detach", {
          sessionId,
        });
      }
      unlisten?.();
    };
  }, [sessionId]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    async function attachExit() {
      unlisten = await getCurrentWebview().listen<TerminalExitPayload>("terminal-exit", (event) => {
        if (event.payload.sessionId !== sessionId) return;
        const exitCode = event.payload.exitCode;
        const message = t("chat.cliExitedWithCode", { engine: engineLabel(settings.aiEngine), exitCode });
        debugCCChanChat("session.exit", {
          sessionId,
          exitCode,
        });
        startingRef.current = false;
        hasSubmittedRef.current = false;
        setStarting(false);
        setSending(false);
        setAutoStartPaused(true);
        setError(message);
        setMessages((current) => [
          ...current,
          createChatMessage("system", message),
        ].slice(-MAX_MESSAGES));
        onSessionIdChange(null);
      });
    }

    if (sessionId) {
      attachExit().catch((err) => {
        const message = getErrorMessage(err);
        debugCCChanChat("exit.attach.fail", {
          sessionId,
          error: message,
          rawError: err,
          cancelled,
        });
        if (!cancelled) setError(message);
      });
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // t 不进 deps：切语言会换 t 的 identity，重跑该 effect 会打断在途的会话 bootstrap
    // （cleanup 置 cancelled=true → setStarting(false) 被跳过 → 控件永久禁用 + CLI 进程成孤儿）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSessionIdChange, sessionId, settings.aiEngine]);

  useEffect(() => {
    const output = outputRef.current;
    if (!output) return;
    if (typeof output.scrollTo === "function") {
      output.scrollTo({ top: output.scrollHeight });
      return;
    }
    output.scrollTop = output.scrollHeight;
  }, [messages]);

  async function handleSubmit() {
    const text = input.trimEnd();
    if (!text || !sessionId || inputDisabled) {
      debugCCChanChat("message.send.skip", {
        autoStartPaused,
        hasText: Boolean(text),
        hasSession: Boolean(sessionId),
        inputDisabled,
      });
      return;
    }
    debugCCChanChat("message.send.begin", {
      sessionId,
      textLength: text.length,
    });
    setInput("");
    setSending(true);
    setError(null);
    hasSubmittedRef.current = true;
    setMessages((current) => [
      ...current,
      createChatMessage("user", text),
    ].slice(-MAX_MESSAGES));
    try {
      await invoke("send_to_ccchan", { sessionId, text });
      debugCCChanChat("message.send.end", {
        sessionId,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      debugCCChanChat("message.send.fail", {
        sessionId,
        error: message,
        rawError: err,
      });
      const uiMessage = t("chat.sendFailed", { error: message });
      setAutoStartPaused(true);
      setError(uiMessage);
      setMessages((current) => [
        ...current,
        createChatMessage("system", uiMessage),
      ].slice(-MAX_MESSAGES));
      onSessionIdChange(null);
    } finally {
      setSending(false);
    }
  }

  function handleRestart() {
    if (controlsDisabled) {
      debugCCChanChat("session.restart.skip.busy", {
        sessionId,
        starting,
        sending,
        restarting,
        checkingSession,
        switchingEngine: switchingEngine ?? null,
      });
      return;
    }
    debugCCChanChat("session.restart.request", {
      aiEngine: settings.aiEngine,
      sessionId,
    });
    hasSubmittedRef.current = false;
    ignoredStartupOutputLoggedRef.current = false;
    verifiedSessionRef.current = null;
    setRestarting(true);
    setAutoStartPaused(false);
    setError(null);
    setMessages([
      createChatMessage("system", t("chat.activityRefreshing", { engine: engineLabel(settings.aiEngine) })),
    ]);
    setRestartRequestId((id) => id + 1);
    if (sessionId) {
      invoke("stop_ccchan_chat", { sessionId })
        .then(() => {
          debugCCChanChat("session.restart.stop.end", {
            sessionId,
          });
        })
        .catch((err) => {
          const message = getErrorMessage(err);
          debugCCChanChat("session.restart.stop.fail", {
            sessionId,
            error: message,
            rawError: err,
          });
        });
    }
    onSessionIdChange(null);
  }

  async function handleStop() {
    if (!sessionId) {
      debugCCChanChat("session.stop.skip.no-session", {});
      return;
    }
    debugCCChanChat("session.stop.begin", {
      sessionId,
    });
    try {
      await invoke("stop_ccchan_chat", { sessionId });
      debugCCChanChat("session.stop.end", {
        sessionId,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      debugCCChanChat("session.stop.fail", {
        sessionId,
        error: message,
        rawError: err,
      });
      throw err;
    } finally {
      hasSubmittedRef.current = false;
      setRestarting(false);
      setAutoStartPaused(true);
      onSessionIdChange(null);
      setMessages([]);
    }
  }

  async function handleEngineChange(nextEngine: AiEngine) {
    if (nextEngine === settings.aiEngine || switchingEngine) {
      debugCCChanChat("engine.change.skip", {
        currentEngine: settings.aiEngine,
        nextEngine,
        switchingEngine: switchingEngine ?? null,
      });
      return;
    }
    debugCCChanChat("engine.change.begin", {
      currentEngine: settings.aiEngine,
      nextEngine,
      hasSession: Boolean(sessionId),
    });
    setSwitchingEngine(nextEngine);
    setAutoStartPaused(false);
    setError(null);
    try {
      if (sessionId) {
        await invoke("stop_ccchan_chat", { sessionId }).catch(() => {});
        onSessionIdChange(null);
      }
      hasSubmittedRef.current = false;
      setMessages([]);
      await saveSettings({ ...settings, aiEngine: nextEngine });
      debugCCChanChat("engine.change.end", {
        nextEngine,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      debugCCChanChat("engine.change.fail", {
        nextEngine,
        error: message,
        rawError: err,
      });
      setError(message);
    } finally {
      setSwitchingEngine(null);
    }
  }

  return (
    <section
      className="flex flex-col overflow-hidden rounded-lg border shadow-2xl"
      style={{
        width,
        height,
        background: "#ffffff",
        borderColor: "#38bdf8",
        color: "#0f172a",
        boxShadow: "0 22px 54px rgba(15, 23, 42, 0.28), 0 0 0 3px rgba(255, 255, 255, 0.76)",
      }}
    >
      <style>{`
        .ccchan-markdown p { margin: 0 0 0.55rem; }
        .ccchan-markdown p:last-child { margin-bottom: 0; }
        .ccchan-markdown ul, .ccchan-markdown ol { margin: 0.25rem 0 0.55rem 1.1rem; padding: 0; }
        .ccchan-markdown li { margin: 0.12rem 0; }
        .ccchan-markdown code { border-radius: 4px; padding: 1px 4px; background: #e2e8f0; color: #0f172a; }
        .ccchan-markdown pre { max-width: 100%; overflow-x: auto; border-radius: 6px; padding: 8px; background: #0f172a; color: #f8fafc; }
        .ccchan-markdown pre code { padding: 0; background: transparent; }
      `}</style>
      <header className="flex h-11 items-center justify-between px-3" style={{ borderBottom: "1px solid #bfdbfe", background: "#f8fafc" }}>
        <div className="flex min-w-0 items-center gap-2">
          <Maximize2 size={14} style={{ color: "#2563eb" }} />
          <span className="truncate text-[13px] font-semibold" style={{ color: "#0f172a" }}>
            {t("brand")} · {activeEngineLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className="flex h-7 items-center overflow-hidden rounded-md border"
            style={{ borderColor: "#bfdbfe", background: "#eff6ff" }}
          >
            {ENGINE_OPTIONS.map((option) => {
              const active = option.value === settings.aiEngine;
              return (
                <button
                  key={option.value}
                  type="button"
                  className="h-full px-2 text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    background: active ? "#bfdbfe" : "transparent",
                    color: active ? "#1d4ed8" : "#475569",
                  }}
                  disabled={controlsDisabled}
                  onClick={() => void handleEngineChange(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40"
            title={t("chat.refreshSession")}
            disabled={controlsDisabled}
            onClick={handleRestart}
          >
            {restarting || starting || checkingSession ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50"
            title={t("chat.stopCurrent")}
            disabled={!sessionId}
            onClick={handleStop}
          >
            <Square size={13} />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-700 transition-colors hover:bg-slate-100"
            title={t("chat.close")}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div
        ref={outputRef}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
        style={{ background: "#f1f5f9" }}
      >
        {!starting && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <ChevronDown size={22} style={{ color: "#64748b" }} />
            <p className="m-0 text-[12px]" style={{ color: "#64748b" }}>
              {t("chat.empty")}
            </p>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {activityLabel && (
          <div className="flex items-center justify-center gap-2 py-2 text-[12px]" style={{ color: "#475569" }}>
            <Loader2 size={13} className="animate-spin" />
            {activityLabel}
          </div>
        )}
        {error && (
          <div className="mx-2 mt-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 p-2.5" style={{ borderTop: "1px solid #bfdbfe", background: "#ffffff" }}>
        <textarea
          value={input}
          className="min-h-[42px] flex-1 resize-none rounded-md px-2.5 py-2 text-[13px] leading-5 outline-none focus:ring-2 focus:ring-sky-200"
          style={{
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            color: "#0f172a",
          }}
          placeholder={autoStartPaused ? t("chat.placeholderPaused") : checkingSession ? t("chat.placeholderChecking") : sessionId ? t("chat.placeholderInput") : t("chat.placeholderStarting")}
          disabled={!sessionId || inputDisabled}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <button
          type="button"
          className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-md transition-colors hover:bg-blue-700 disabled:opacity-50"
          style={{ background: "#2563eb", color: "#ffffff" }}
          disabled={!sessionId || inputDisabled || input.trimEnd().length === 0}
          title={t("chat.send")}
          onClick={() => void handleSubmit()}
        >
          <Send size={16} />
        </button>
      </div>
    </section>
  );
}
