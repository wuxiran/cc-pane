// agent-chat 附件摄取 hook：对话框 / 粘贴 / 拖放三条入口 → 附件列表状态。
// 从 ChatComposer 拆出（行数棘轮）。桌面端两条关键链路：
// - 粘贴：资源管理器复制的文件走 CF_HDROP，网页层 clipboardData 看不到，
//   必须问后端 read_clipboard_file_paths 要文件清单；
// - 拖放：WebView2 拦截 HTML5 drop（dragDropEnabled 默认开），只有 Tauri
//   原生 onDragDropEvent 能拿到真实路径；web 部署没有这层拦截，HTML5 兜底
//   留在组件里。
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import type { AgentChatAttachment } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { screenshotService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { readClipboardFilePaths } from "@/components/panes/terminalClipboard";
import { isDropInsideTerminalHost } from "@/components/panes/terminalDrop";
import { baseName, planPathAttachment } from "./chatAttachments";

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
  const [attachments, setAttachments] = useState<AgentChatAttachment[]>([]);
  const [dropHint, setDropHint] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /** 路径 → 附件的统一入口（对话框/粘贴/拖放共用）：图片且引擎支持才内嵌，
   * 其余转 resource_link 文件引用。 */
  const attachPaths = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        const name = baseName(path);
        if (planPathAttachment(path, imageSupported) === "file") {
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
    },
    [chatId, imageSupported],
  );

  /** 无路径的剪贴板图片：引擎支持内嵌就读成 base64；不支持时落盘到截图目录
   * 转文件引用（ACP 基线能力），不再直接丢弃。 */
  const pushFileAttachment = useCallback(
    (file: File, fallbackName: string) => {
      if (!imageSupported) {
        void (async () => {
          try {
            const saved = isTauriRuntime() ? await screenshotService.saveClipboardImage() : null;
            if (saved?.filePath) {
              await attachPaths([saved.filePath]);
              return;
            }
          } catch (error) {
            handleErrorSilent(error, "persist pasted image for acp attachment");
          }
          useAgentChatStore.getState().pushNotice(chatId, t("agentChatImageUnsupported"));
        })();
        return;
      }
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
    },
    [chatId, imageSupported, t, attachPaths],
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

  const clearAttachments = useCallback(() => setAttachments([]), []);

  const removeAttachment = useCallback(
    (index: number) =>
      setAttachments((previous) => previous.filter((_, itemIndex) => itemIndex !== index)),
    [],
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
