// agent-chat 附件摄取 hook：对话框 / 粘贴 / 拖放三条入口 → 附件列表状态。
// 从 ChatComposer 拆出（行数棘轮）。桌面端两条关键链路：
// - 粘贴：资源管理器复制的文件走 CF_HDROP，网页层 clipboardData 看不到，
//   必须问后端 read_clipboard_file_paths 要文件清单；
// - 拖放：WebView2 拦截 HTML5 drop（dragDropEnabled 默认开），只有 Tauri
//   原生 onDragDropEvent 能拿到真实路径；web 部署没有这层拦截，HTML5 兜底
//   留在组件里。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import type { AgentChatAttachment } from "@/types/agentChat";
import { screenshotService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, EMPTY_CHAT_ATTACHMENTS, isChatDraftCurrent, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { translateError } from "@/utils/errorTranslation";
import { readClipboardFilePaths } from "@/components/panes/terminalClipboard";
import { isDropInsideTerminalHost } from "@/components/panes/terminalDrop";
import { attachChatPaths } from "./attachChatPaths";

export interface ComposerAttachmentsApi {
  attachments: AgentChatAttachment[];
  clearAttachments: () => void;
  removeAttachment: (index: number) => void;
  /** 原生拖放悬停在输入区内（边框高亮提示）。 */
  dropHint: boolean;
  /** 拖放命中判定用的宿主元素（挂在输入区容器上）。 */
  hostRef: React.RefObject<HTMLDivElement | null>;
  attachFromDialog: () => Promise<void>;
  /** 无路径的剪贴板位图（截图/复制的图像数据）。 */
  pushFileAttachment: (file: File, fallbackName: string) => void;
  /** 后端剪贴板文件清单 → 附件；返回附上的数量（0 = 剪贴板里没有文件）。 */
  attachClipboardFiles: () => Promise<number>;
}

export function useComposerAttachments(
  chatId: string,
  imageSupported: boolean,
): ComposerAttachmentsApi {
  const { t } = useTranslation("panes");
  const draftToken = useMemo(() => acquireChatDraft(chatId), [chatId]);
  const attachments = useAgentChatDraftStore((state) => state.drafts[chatId]?.attachments ?? EMPTY_CHAT_ATTACHMENTS);
  const [dropHint, setDropHint] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const attachPaths = useCallback(
    (paths: string[]) => attachChatPaths(chatId, draftToken, imageSupported, paths),
    [chatId, draftToken, imageSupported],
  );

  /** Read the supplied bitmap itself, including drops. Never substitute the system
   * clipboard: it may already contain a different image when this read completes. */
  const pushFileAttachment = useCallback(
    (file: File, fallbackName: string) => {
      const notice = (message: string) => {
        if (isChatDraftCurrent(chatId, draftToken)) useAgentChatStore.getState().pushNotice(chatId, message);
      };
      if (file.size > 10 * 1024 * 1024) { notice(t("agentChatImageTooLarge")); return; }
      const reader = new FileReader();
      reader.onerror = () => notice(t("agentChatImageReadFailed"));
      reader.onload = () => {
        if (!isChatDraftCurrent(chatId, draftToken)) return;
        const result = reader.result;
        const base64 = typeof result === "string" ? result.split(",", 2)[1] : undefined;
        if (!base64) { notice(t("agentChatImageReadFailed")); return; }
        if (imageSupported) {
          useAgentChatDraftStore.getState().addAttachments(chatId, draftToken, [
            { name: file.name || fallbackName, mimeType: file.type || "image/png", data: base64, kind: "image" },
          ]);
          return;
        }
        if (!isTauriRuntime()) { notice(t("agentChatImageUnsupported")); return; }
        void screenshotService.saveImageAttachment(base64)
          .then((saved) => saved ? attachPaths([saved.filePath]) : notice(t("agentChatImageReadFailed")))
          .catch((error) => {
            handleErrorSilent(error, "persist image for acp attachment");
            notice(translateError(error));
          });
      };
      reader.readAsDataURL(file);
    },
    [chatId, draftToken, imageSupported, t, attachPaths],
  );

  /** 附件对话框：选中的文件走统一 attachPaths。 */
  const attachFromDialog = useCallback(async () => {
    const picked = await openFileDialog({ multiple: true, directory: false }).catch(() => null);
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    await attachPaths(paths);
  }, [attachPaths]);

  const attachClipboardFiles = useCallback(async () => {
    const { paths } = await readClipboardFilePaths();
    if (paths.length === 0) return 0;
    await attachPaths(paths);
    return paths.length;
  }, [attachPaths]);

  // Tauri 原生拖放：只有 onDragDropEvent 能拿到真实文件路径（同终端的做法）。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        const host = hostRef.current;
        if (!host) return;
        if (payload.type === "enter") {
          if (isDropInsideTerminalHost(host, payload.position)) setDropHint(true);
          return;
        }
        if (payload.type === "leave") {
          setDropHint(false);
          return;
        }
        if (payload.type !== "drop") return;
        setDropHint(false);
        if (!isDropInsideTerminalHost(host, payload.position)) return;
        void attachPaths(payload.paths);
      })
      .then((unlistenFn) => {
        if (disposed) unlistenFn();
        else unlisten = unlistenFn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [attachPaths]);

  const clearAttachments = useCallback(() => useAgentChatDraftStore.getState().clearAttachments(chatId, draftToken), [chatId, draftToken]);

  const removeAttachment = useCallback(
    (index: number) =>
      useAgentChatDraftStore.getState().removeAttachment(chatId, draftToken, index),
    [chatId, draftToken],
  );

  return {
    attachments,
    clearAttachments,
    removeAttachment,
    dropHint,
    hostRef,
    attachFromDialog,
    pushFileAttachment,
    attachClipboardFiles,
  };
}
