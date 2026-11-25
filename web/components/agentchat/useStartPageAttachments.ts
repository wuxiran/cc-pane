// 启动页附件：复用会话内输入区的附件状态（useComposerAttachments，草稿按 chatId 存，
// 会话启动后由 EnginePicker 清掉已随首条消息交出的附件），拖放走 useStartPageFileDrop，
// 粘贴与会话内输入区同优先级（位图 → 文件清单 → 纯文本）。
// 会话尚未启动时引擎的 promptCapabilities 未知，按「不支持内嵌图片」摄取：有路径的图片
// 成为文件引用、无路径位图落盘后引用——与会话内输入区对不支持图片引擎的处理一致。
// 提示不能 push 进对话（会把启动页顶成会话视图），改投启动页自己的错误位。
import { useCallback, type ClipboardEvent, type RefObject } from "react";
import { isTauriRuntime } from "@/services/runtime";
import { useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { useComposerAttachments, type ComposerAttachmentsApi } from "./useComposerAttachments";
import { useStartPageFileDrop } from "./useStartPageFileDrop";

export interface StartPageAttachmentsApi extends ComposerAttachmentsApi {
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}

export function useStartPageAttachments(
  chatId: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  setDraft: (update: (previous: string) => string) => void,
  onNotice: (message: string) => void,
): StartPageAttachmentsApi {
  const api = useComposerAttachments(chatId, false, { nativeDrop: false, onNotice });
  const { attachPaths, pushFileAttachment, attachClipboardFiles } = api;
  const knownPaths = useCallback(
    () => (useAgentChatDraftStore.getState().drafts[chatId]?.attachments ?? [])
      .map((attachment) => attachment.path)
      .filter((path): path is string => Boolean(path)),
    [chatId],
  );
  useStartPageFileDrop(textareaRef, attachPaths, knownPaths);

  const insertTextAtCursor = useCallback((text: string) => {
    const element = textareaRef.current;
    setDraft((previous) => {
      const start = element?.selectionStart ?? previous.length;
      const end = element?.selectionEnd ?? start;
      return previous.slice(0, start) + text + previous.slice(end);
    });
  }, [setDraft, textareaRef]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length > 0) {
      event.preventDefault();
      for (const file of imageFiles) pushFileAttachment(file, "pasted.png");
      return;
    }
    // 资源管理器复制的文件（CF_HDROP）网页层看不到：问后端要清单，没有再插回文本。
    if (!isTauriRuntime()) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    void attachClipboardFiles()
      .then((attached) => {
        if (attached === 0 && text) insertTextAtCursor(text);
      })
      .catch(() => {
        if (text) insertTextAtCursor(text);
      });
  }, [pushFileAttachment, attachClipboardFiles, insertTextAtCursor]);

  return { ...api, handlePaste };
}
