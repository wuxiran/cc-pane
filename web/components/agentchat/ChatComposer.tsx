// agent-chat 输入区：草稿/发送历史/斜杠命令/@引用 全部自持。
// 从 AgentChatTabContent 拆出（行数棘轮）；附件摄取（对话框/粘贴/拖放）在
// useComposerAttachments hook。发送块组装（text/image/resource_link）也在这里
// ——父组件只提供会话身份与相位。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, FileText, ImageIcon, Plus, RotateCw, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AcpAvailableCommand, AcpChatPhase, AcpUsage } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { isTauriRuntime } from "@/services/runtime";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { buildPromptBlocks } from "./chatPrompt";
import { submitReservedPrompt } from "./submitReservedPrompt";
import { useComposerAttachments } from "./useComposerAttachments";
import ChatVoiceButton from "./ChatVoiceButton";
import ContextUsageRing from "./ContextUsageRing";

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
  const lastUserMessage = useAgentChatStore((state) => {
    const chat = state.chats[chatId];
    if (chat?.rejectedPrompt) return chat.rejectedPrompt;
    const chatItems = chat?.items;
    if (!chatItems) return null;
    for (let index = chatItems.length - 1; index >= 0; index -= 1) {
      const item = chatItems[index];
      if (item.type === "user") return item;
    }
    return null;
  });
  // ACP promptCapabilities：image 缺省为 false（协议规定），不支持时图片不内嵌——有路径的转
  // resource_link，粘贴/拖放的（无路径）提示并丢弃，避免 agent 直接拒绝整条 prompt。
  const imageSupported = useAgentChatStore((state) => {
    const caps = state.chats[chatId]?.snapshot?.agentCapabilities as
      | { promptCapabilities?: { image?: boolean } }
      | undefined;
    return caps?.promptCapabilities?.image === true;
  });
  const submissionBlocked = useAgentChatStore((state) => {
    const chat = state.chats[chatId];
    return Boolean(chat?.pendingPrompt || chat?.setup?.pending || chat?.setup?.error
      || (chat?.snapshot && chat.snapshot.phase !== "ready"));
  });
  const draftToken = useMemo(() => acquireChatDraft(chatId), [chatId]);
  const draft = useAgentChatDraftStore((state) => state.drafts[chatId]?.text ?? "");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const historyIndexRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    attachments,
    clearAttachments,
    removeAttachment,
    dropHint,
    hostRef,
    attachFromDialog,
    pushFileAttachment,
    attachClipboardFiles,
  } = useComposerAttachments(chatId, imageSupported);

  const setDraft = useCallback(
    (value: string) => {
      useAgentChatDraftStore.getState().setText(chatId, draftToken, value);
    },
    [chatId, draftToken],
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

  /** 手动把文本插到光标处（接管粘贴后，默认插入行为已被 preventDefault）。 */
  const insertTextAtCursor = useCallback(
    (text: string) => {
      const element = textareaRef.current;
      const start = element?.selectionStart ?? draft.length;
      const end = element?.selectionEnd ?? start;
      historyIndexRef.current = null;
      setDraft(draft.slice(0, start) + text + draft.slice(end));
      requestAnimationFrame(() => {
        element?.focus();
        const caret = start + text.length;
        element?.setSelectionRange(caret, caret);
      });
    },
    [draft, setDraft],
  );

  /** HTML5 拖放（web 部署兜底；桌面端由 hook 里的原生 onDragDropEvent 接管）：
   * 位图 File 没有路径，只能走内嵌/落盘。 */
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
      // 截图/复制的位图会作为 image File 出现在网页剪贴板里，优先内嵌处理。
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (imageFiles.length > 0) {
        event.preventDefault();
        for (const file of imageFiles) pushFileAttachment(file, "pasted.png");
        return;
      }
      // 资源管理器复制的文件走 CF_HDROP，网页层 clipboardData 看不到——接管
      // 粘贴问后端要文件清单；没有文件再手动插回文本（与终端粘贴同优先级）。
      if (!isTauriRuntime()) return;
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      void (async () => {
        const attached = await attachClipboardFiles();
        if (attached > 0 || !text) return;
        insertTextAtCursor(text);
      })();
    },
    [pushFileAttachment, attachClipboardFiles, insertTextAtCursor],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || phase !== "ready") return;

    const blocks = buildPromptBlocks(text, attachments, cwd);
    const token = useAgentChatStore.getState().beginPrompt(chatId, { text, attachments, promptBlocks: blocks });
    if (token === null) return;

    setDraft("");
    clearAttachments();
    onBeforeSend?.();
    historyIndexRef.current = null;
    if (text) useAgentChatDraftStore.getState().rememberSent(chatId, draftToken, text);
    void submitReservedPrompt(chatId, token, blocks).catch((error) => handleErrorSilent(error, "submit acp prompt"));
  }, [draft, attachments, phase, chatId, cwd, draftToken, setDraft, clearAttachments, onBeforeSend]);

  const recallHistory = useCallback(
    (direction: -1 | 1) => {
      const history = useAgentChatDraftStore.getState().drafts[chatId]?.sentHistory ?? [];
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

  /** 重试上一轮：保留原始 blocks，包含仅附件消息以及发送时解析出的绝对引用。 */
  const retryLast = useCallback(() => {
    if (!lastUserMessage || phase !== "ready") return;
    const blocks = lastUserMessage.promptBlocks
      ?? buildPromptBlocks(lastUserMessage.text, lastUserMessage.attachments ?? [], cwd);
    if (blocks.length === 0) return;
    const token = useAgentChatStore.getState().beginPrompt(chatId, {
      text: lastUserMessage.text, attachments: lastUserMessage.attachments, promptBlocks: blocks,
    });
    if (token === null) return;
    onBeforeSend?.();
    void submitReservedPrompt(chatId, token, blocks).catch((error) => handleErrorSilent(error, "retry acp prompt"));
  }, [chatId, lastUserMessage, phase, onBeforeSend, cwd]);

  const canSend = phase === "ready" && !submissionBlocked && (Boolean(draft.trim()) || attachments.length > 0);

  return (
    <div ref={hostRef} className="agent-chat-composer px-5 pb-5 pt-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {slashMatches.length > 0 ? (
          <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-overlay)] py-1 shadow-md">
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
          data-drop-active={dropHint || undefined}
          className={`agent-chat-composer-shell rounded-3xl border bg-[var(--app-chat-composer-bg)] px-4 pb-3 pt-4 transition-[border-color,box-shadow] duration-[var(--dur)] ease-[var(--ease-out)] focus-within:border-[var(--app-text-tertiary)] ${
            dropHint
              ? "border-[var(--app-accent)] shadow-[0_0_0_3px_var(--app-active-bg)]"
              : "border-[var(--app-border)]"
          }`}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {attachments.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <span
                  key={index}
                  className="flex min-w-0 items-center gap-1.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-1.5 text-xs text-[var(--app-text-secondary)]"
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
                    onClick={() => removeAttachment(index)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
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
            className="agent-chat-composer-input max-h-48 min-h-[4.25rem] w-full resize-none bg-transparent text-[15px] leading-relaxed text-[var(--app-text-primary)] outline-none placeholder:text-[var(--app-text-tertiary)]"
          />
          <div className="agent-chat-composer-toolbar mt-3 flex items-end justify-between gap-3">
            <div className="agent-chat-composer-options flex min-w-0 flex-wrap items-center gap-1.5">
              <IconTooltipButton
                label={t("agentChatAttach")}
                className="h-8 w-8 shrink-0 rounded-full"
                onClick={() => void attachFromDialog()}
              >
                <Plus className="h-4 w-4" />
              </IconTooltipButton>
              {toolbar}
            </div>
            <div className="agent-chat-composer-actions flex shrink-0 items-center gap-1.5">
              {usage ? <ContextUsageRing usage={usage} /> : null}
              {lastUserMessage && !generating ? (
                <IconTooltipButton
                  label={t("agentChatRetry")}
                  disabled={phase !== "ready" || submissionBlocked}
                  className="h-8 w-8 rounded-full"
                  onClick={retryLast}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </IconTooltipButton>
              ) : null}
              <ChatVoiceButton
                chatId={chatId}
                variant="ghost"
                sizeClass="h-8 w-8 rounded-full"
                onText={(text) => useAgentChatDraftStore.getState().appendText(chatId, draftToken, text)}
              />
              {generating ? (
                <IconTooltipButton
                  label={t("agentChatStop")}
                  className="h-8 w-8 rounded-full bg-[var(--app-text-primary)] text-[var(--app-panel-bg)] hover:bg-[var(--app-text-primary)] hover:text-[var(--app-panel-bg)] hover:opacity-85"
                  onClick={cancel}
                >
                  <Square className="h-3 w-3 fill-current" />
                </IconTooltipButton>
              ) : (
                <IconTooltipButton
                  label={t("agentChatSend")}
                  kbd="Enter"
                  disabled={!canSend}
                  className="h-8 w-8 rounded-full bg-[var(--app-text-primary)] text-[var(--app-panel-bg)] hover:bg-[var(--app-text-primary)] hover:text-[var(--app-panel-bg)] hover:opacity-85 disabled:opacity-30"
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
