// agent-chat 输入区：草稿/发送历史/图片附件/斜杠命令/@引用 全部自持。
// 从 AgentChatTabContent 拆出（行数棘轮）。发送块组装（text/image/resource_link）
// 也在这里——父组件只提供会话身份与相位。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, FileText, ImageIcon, Plus, RotateCw, Square, X } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type {
  AcpAvailableCommand,
  AcpChatPhase,
  AcpUsage,
  AgentChatAttachment,
} from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { isAbsolutePath, joinCwd, toFileUri } from "./chatPaths";
import ChatVoiceButton from "./ChatVoiceButton";
import ContextUsageRing from "./ContextUsageRing";

// 草稿与发送历史按 tabId 缓存在模块级：组件卸载（切标签）不丢。
const draftCache = new Map<string, string>();
const sentHistoryCache = new Map<string, string[]>();
const SENT_HISTORY_LIMIT = 50;

export interface ChatComposerProps {
  chatId: string;
  cwd: string;
  phase: AcpChatPhase | undefined;
  generating: boolean;
  availableCommands: AcpAvailableCommand[];
  /** 发送前回调（父组件借此恢复吸底滚动）。 */
  onBeforeSend?: () => void;
  /** 底栏左侧的会话级选择器（模型/模式/权限），由父组件注入。 */
  toolbar?: ReactNode;
  /** 上下文用量（引擎不上报时为 null，不渲染环）。 */
  usage?: AcpUsage | null;
}

export default function ChatComposer({
  chatId,
  cwd,
  phase,
  generating,
  availableCommands,
  onBeforeSend,
  toolbar,
  usage,
}: ChatComposerProps) {
  const { t } = useTranslation("panes");
  // 最后一条用户消息（重试上一轮用；从 store 取，重挂载不丢）。
  const lastUserText = useAgentChatStore((state) => {
    const chatItems = state.chats[chatId]?.items;
    if (!chatItems) return null;
    for (let index = chatItems.length - 1; index >= 0; index -= 1) {
      const item = chatItems[index];
      if (item.type === "user" && item.text) return item.text;
    }
    return null;
  });
  const [draft, setDraftState] = useState(() => draftCache.get(chatId) ?? "");
  const [attachments, setAttachments] = useState<AgentChatAttachment[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const historyIndexRef = useRef<number | null>(null);

  const setDraft = useCallback(
    (value: string) => {
      draftCache.set(chatId, value);
      setDraftState(value);
    },
    [chatId],
  );

  // `/` 开头且未含空格 → 斜杠命令菜单（点击/键盘补全，发送仍是普通文本 prompt）。
  const slashMatches = useMemo(() => {
    if (
      slashDismissed
      || !draft.startsWith("/")
      || /\s/.test(draft)
      || availableCommands.length === 0
    ) {
      return [];
    }
    const query = draft.slice(1).toLowerCase();
    return availableCommands
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .slice(0, 8);
  }, [draft, availableCommands, slashDismissed]);

  // 尾部 `@token` → 文件引用提示（发送时转 resource_link 块）。
  const mentionQuery = useMemo(() => {
    const match = /(?:^|\s)@(\S*)$/.exec(draft);
    return match ? match[1] : null;
  }, [draft]);

  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [draft]);

  const pushFileAttachment = useCallback((file: File, fallbackName: string) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      const base64 = result.split(",", 2)[1] ?? "";
      if (!base64) return;
      setAttachments((previous) => [
        ...previous,
        { name: file.name || fallbackName, mimeType: file.type, data: base64 },
      ]);
    };
    reader.readAsDataURL(file);
  }, []);

  /** 附件对话框：图片内嵌为 image 块，其余文件转 resource_link（引用不内嵌）。 */
  const attachFromDialog = useCallback(async () => {
    const picked = await openFileDialog({ multiple: true, directory: false }).catch(() => null);
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() || path;
      const extension = name.split(".").pop()?.toLowerCase() ?? "";
      if (!imageExtensions.has(extension)) {
        setAttachments((previous) => [
          ...previous,
          { name, mimeType: "", data: "", kind: "file", path },
        ]);
        continue;
      }
      try {
        const image = await agentChatService.readImageAttachment(path);
        setAttachments((previous) => [
          ...previous,
          { name, mimeType: image.mimeType, data: image.dataBase64, kind: "image" },
        ]);
      } catch (error) {
        useAgentChatStore
          .getState()
          .pushNotice(chatId, error instanceof Error ? error.message : String(error));
      }
    }
  }, [chatId]);

  /** HTML5 拖放：Tauri 若拦截了 drop 事件则此路径静默不触发，附件按钮兜底。 */
  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      event.preventDefault();
      for (const file of files) pushFileAttachment(file, "dropped.png");
    },
    [pushFileAttachment],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      for (const file of files) pushFileAttachment(file, "pasted.png");
    },
    [pushFileAttachment],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || phase !== "ready") return;

    const blocks: unknown[] = attachments.map((attachment) =>
      attachment.kind === "file" && attachment.path
        ? { type: "resource_link", uri: toFileUri(attachment.path), name: attachment.name }
        : { type: "image", mimeType: attachment.mimeType, data: attachment.data },
    );
    // `@路径` → resource_link 块（ACP 基线能力，所有 agent 必须支持）。
    for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const mention = match[1];
      const absolute = isAbsolutePath(mention) ? mention : joinCwd(cwd || ".", mention);
      blocks.push({ type: "resource_link", uri: toFileUri(absolute), name: mention });
    }
    if (text) blocks.push({ type: "text", text });

    setDraft("");
    const sentAttachments = attachments;
    setAttachments([]);
    onBeforeSend?.();
    historyIndexRef.current = null;
    if (text) {
      const history = sentHistoryCache.get(chatId) ?? [];
      history.push(text);
      if (history.length > SENT_HISTORY_LIMIT) history.shift();
      sentHistoryCache.set(chatId, history);
    }
    useAgentChatStore.getState().addUserMessage(
      chatId,
      text,
      sentAttachments.map((attachment) => attachment.name),
    );
    void agentChatService.prompt(chatId, blocks).catch((error) => {
      useAgentChatStore
        .getState()
        .pushNotice(chatId, error instanceof Error ? error.message : String(error));
    });
  }, [draft, attachments, phase, chatId, cwd, setDraft, onBeforeSend]);

  const recallHistory = useCallback(
    (direction: -1 | 1) => {
      const history = sentHistoryCache.get(chatId) ?? [];
      if (history.length === 0) return false;
      const current = historyIndexRef.current;
      let next: number | null;
      if (direction === -1) {
        next = current === null ? history.length - 1 : Math.max(0, current - 1);
      } else if (current === null) {
        return false;
      } else if (current >= history.length - 1) {
        next = null;
      } else {
        next = current + 1;
      }
      historyIndexRef.current = next;
      setDraft(next === null ? "" : history[next]);
      return true;
    },
    [chatId, setDraft],
  );

  const cancel = useCallback(() => {
    void agentChatService.cancel(chatId).catch((error) => {
      handleErrorSilent(error, "cancel acp chat turn");
    });
  }, [chatId]);

  /** 重试上一轮：原样重发最后一条用户消息（附件/文件引用不重放）。 */
  const retryLast = useCallback(() => {
    if (!lastUserText || phase !== "ready") return;
    onBeforeSend?.();
    useAgentChatStore.getState().addUserMessage(chatId, lastUserText, []);
    void agentChatService.prompt(chatId, [{ type: "text", text: lastUserText }]).catch((error) => {
      useAgentChatStore
        .getState()
        .pushNotice(chatId, error instanceof Error ? error.message : String(error));
    });
  }, [chatId, lastUserText, phase, onBeforeSend]);

  const canSend = phase === "ready" && (Boolean(draft.trim()) || attachments.length > 0);

  return (
    <div className="px-3 pb-3 pt-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {slashMatches.length > 0 ? (
          <div className="flex flex-col overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-overlay)] shadow-md">
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                className={`flex items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)] ${
                  index === slashIndex ? "bg-[var(--app-active-bg)]" : ""
                }`}
                onMouseEnter={() => setSlashIndex(index)}
                onClick={() => setDraft(`/${command.name} `)}
              >
                <span className="font-mono text-xs">/{command.name}</span>
                {command.description ? (
                  <span className="truncate text-[11px] text-[var(--app-text-tertiary)]">
                    {command.description}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        {mentionQuery !== null ? (
          <div className="px-1 text-[11px] text-[var(--app-text-tertiary)]">
            {t("agentChatMentionHint", { query: mentionQuery || "…" })}
          </div>
        ) : null}
        <div
          className="rounded-xl border border-[var(--app-border)] bg-[var(--app-chat-composer-bg)] px-3 pb-2 pt-2.5 shadow-sm transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)] focus-within:border-[var(--app-accent)]/70 focus-within:shadow-[0_0_0_3px_var(--app-active-bg)]"
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment, index) => (
                <span
                  key={index}
                  className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-1.5 py-0.5 text-[11px] text-[var(--app-text-secondary)]"
                >
                  {attachment.kind === "file" ? (
                    <FileText className="h-3 w-3" />
                  ) : (
                    <ImageIcon className="h-3 w-3" />
                  )}
                  <span className="max-w-48 truncate">{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={t("agentChatRemoveAttachment")}
                    className="rounded hover:text-[var(--app-status-danger)]"
                    onClick={() =>
                      setAttachments((previous) =>
                        previous.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => {
              historyIndexRef.current = null;
              setDraft(event.target.value);
            }}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              // 斜杠菜单打开时接管 ↑↓/Tab/Enter/Esc。
              if (slashMatches.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((previous) => (previous + 1) % slashMatches.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex(
                    (previous) => (previous - 1 + slashMatches.length) % slashMatches.length,
                  );
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  event.preventDefault();
                  const command = slashMatches[slashIndex] ?? slashMatches[0];
                  setDraft(`/${command.name} `);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
                return;
              }
              // 输入历史：仅在光标位于首/末行时响应，避免抢占多行编辑。
              const target = event.currentTarget;
              if (
                event.key === "ArrowUp"
                && !target.value.slice(0, target.selectionStart).includes("\n")
              ) {
                if (recallHistory(-1)) event.preventDefault();
              } else if (
                event.key === "ArrowDown"
                && !target.value.slice(target.selectionEnd).includes("\n")
                && historyIndexRef.current !== null
              ) {
                if (recallHistory(1)) event.preventDefault();
              }
            }}
            placeholder={t("agentChatSendPlaceholder")}
            rows={2}
            className="max-h-48 min-h-[2.75rem] w-full resize-none bg-transparent text-sm leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
          />
          <div className="mt-1.5 flex items-end justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <IconTooltipButton
                label={t("agentChatAttach")}
                className="h-7 w-7 shrink-0"
                onClick={() => void attachFromDialog()}
              >
                <Plus className="h-4 w-4" />
              </IconTooltipButton>
              {toolbar}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {usage ? <ContextUsageRing usage={usage} /> : null}
              {lastUserText && !generating ? (
                <IconTooltipButton
                  label={t("agentChatRetry")}
                  disabled={phase !== "ready"}
                  className="h-7 w-7"
                  onClick={retryLast}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </IconTooltipButton>
              ) : null}
              <ChatVoiceButton
                chatId={chatId}
                variant="ghost"
                onText={(text) => setDraft(draft ? `${draft} ${text}` : text)}
              />
              {generating ? (
                <IconTooltipButton
                  label={t("agentChatStop")}
                  className="h-7 w-7 rounded-full bg-[var(--app-text-primary)] text-[var(--app-panel-bg)] hover:bg-[var(--app-text-primary)] hover:text-[var(--app-panel-bg)] hover:opacity-85"
                  onClick={cancel}
                >
                  <Square className="h-3 w-3 fill-current" />
                </IconTooltipButton>
              ) : (
                <IconTooltipButton
                  label={t("agentChatSend")}
                  kbd="Enter"
                  disabled={!canSend}
                  className="h-7 w-7 rounded-full bg-[var(--app-accent)] text-white hover:bg-[var(--app-accent)] hover:text-white hover:opacity-90 disabled:opacity-35"
                  onClick={send}
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                </IconTooltipButton>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
