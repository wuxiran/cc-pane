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
import { baseName } from "./chatAttachments";

export interface ComposerAttachmentsApi {
  attachments: AgentChatAttachment[];
  clearAttachments: () => void;
  removeAttachment: (index: number) => void;
  /** 原生拖放悬停在输入区内（边框高亮提示）。 */
  dropHint: boolean;
  /** 拖放命中判定用的宿主元素（挂在输入区容器上）。 */
  hostRef: React.RefObject<HTMLDivElement | null>;
  attachFromDialog: () => Promise<void>;
  attachFoldersFromDialog: () => Promise<void>;
  attachDirectory: (path: string) => void;
  /** 无路径的剪贴板位图（截图/复制的图像数据）。 */
  pushFileAttachment: (file: File, fallbackName: string) => void;
  /** 后端剪贴板文件清单 → 附件；返回附上的数量（0 = 剪贴板里没有文件）。 */
  attachClipboardFiles: () => Promise<number>;
  /** 路径 → 附件（拖放/对话框共用的摄取入口）。 */
  attachPaths: (paths: string[]) => Promise<void>;
}

export interface ComposerAttachmentsOptions {
  /** false = 不挂内置的原生拖放监听（启动页用 useStartPageFileDrop 自己接线）。 */
  nativeDrop?: boolean;
  /** 提示改投这里（启动页：往对话里 push notice 会让启动页被会话视图顶掉）。 */
  onNotice?: (message: string) => void;
}

export function useComposerAttachments(
  chatId: string,
  imageSupported: boolean,
  options: ComposerAttachmentsOptions = {},
): ComposerAttachmentsApi {
  const { t } = useTranslation("panes");
  const { nativeDrop = true, onNotice } = options;
  const draftToken = useMemo(() => acquireChatDraft(chatId), [chatId]);
  const attachments = useAgentChatDraftStore((state) => state.drafts[chatId]?.attachments ?? EMPTY_CHAT_ATTACHMENTS);
  const [dropHint, setDropHint] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const attachPaths = useCallback(
    (paths: string[]) => attachChatPaths(chatId, draftToken, imageSupported, paths, onNotice),
    [chatId, draftToken, imageSupported, onNotice],
  );

  /** Read the supplied bitmap itself, including drops. Never substitute the system
   * clipboard: it may already contain a different image when this read completes. */
  const pushFileAttachment = useCallback(
    (file: File, fallbackName: string) => {
      const notice = (message: string) => {
        if (!isChatDraftCurrent(chatId, draftToken)) return;
        if (onNotice) onNotice(message);
        else useAgentChatStore.getState().pushNotice(chatId, message);
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
    [chatId, draftToken, imageSupported, t, attachPaths, onNotice],
  );

  /** 附件对话框：选中的文件走统一 attachPaths。 */
  const attachFromDialog = useCallback(async () => {
    const picked = await openFileDialog({ multiple: true, directory: false });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    await attachPaths(paths);
  }, [attachPaths]);

  // A directory is a reference, even when its name ends in .png. Do not scan
  // its contents or read it as an image merely to show an attachment chip.
  const attachDirectory = useCallback((path: string) => {
    if (!path || !isChatDraftCurrent(chatId, draftToken)) return;
    const name = baseName(path.replace(/[\\/]+$/, "")) || path;
    useAgentChatDraftStore.getState().addAttachments(chatId, draftToken, [
      { name, path, kind: "file", mimeType: "", data: "", isDirectory: true },
    ]);
  }, [chatId, draftToken]);

  const attachFoldersFromDialog = useCallback(async () => {
    const picked = await openFileDialog({ multiple: true, directory: true });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    paths.forEach(attachDirectory);
  }, [attachDirectory]);

  const attachClipboardFiles = useCallback(async () => {
    const { paths } = await readClipboardFilePaths();
    if (paths.length === 0) return 0;
    await attachPaths(paths);
    return paths.length;
  }, [attachPaths]);

  // Tauri 原生拖放：只有 onDragDropEvent 能拿到真实文件路径（同终端的做法）。
  // 落点是整个对话区（消息列表 + 输入框，标了 data-agent-chat-drop-zone），
  // 不只输入框；悬停时在对话区上盖一层「松开添加到对话」提示。
  useEffect(() => {
    if (!nativeDrop || !isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const zoneOf = (host: HTMLElement) =>
      host.closest<HTMLElement>("[data-agent-chat-drop-zone]") ?? host;
    const setZoneActive = (zone: HTMLElement, active: boolean) => {
      if (active) {
        zone.dataset.chatDropActive = "true";
        zone.dataset.chatDropLabel = t("agentChatDropToAttach");
      } else {
        delete zone.dataset.chatDropActive;
      }
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        const host = hostRef.current;
        if (!host) return;
        const zone = zoneOf(host);
        if (payload.type === "enter" || payload.type === "over") {
          const inside = isDropInsideTerminalHost(zone, payload.position);
          setDropHint(inside);
          setZoneActive(zone, inside);
          return;
        }
        setDropHint(false);
        setZoneActive(zone, false);
        if (payload.type !== "drop") return;
        if (!isDropInsideTerminalHost(zone, payload.position)) return;
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
      const host = hostRef.current;
      if (host) setZoneActive(zoneOf(host), false);
    };
  }, [attachPaths, nativeDrop, t]);

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
    attachFoldersFromDialog,
    attachDirectory,
    pushFileAttachment,
    attachClipboardFiles,
    attachPaths,
  };
}
