import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AgentChatAttachment } from "@/types/agentChat";
import { filesystemService } from "@/services/filesystemService";
import { screenshotService } from "@/services/screenshotService";
import { isTauriRuntime } from "@/services/runtime";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { translateError } from "@/utils/errorTranslation";
import { resolveRelativeFromDir } from "@/utils/mdAssetPath";
import { isAbsolutePath } from "./chatPaths";
import { parseFileRef } from "./chatFileRefs";

export type OpenChatAttachment = (attachment: AgentChatAttachment) => Promise<boolean>;
const MAX_IMAGE_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4;
// Weak keys preserve the original prompt bytes without retaining old conversations.
// The pending promise also coalesces repeated clicks before persistence finishes.
const savedImages = new WeakMap<AgentChatAttachment, Promise<string | null>>();

function persistImage(attachment: AgentChatAttachment): Promise<string | null> {
  const cached = savedImages.get(attachment);
  if (cached) return cached;
  const pending = screenshotService.saveImageAttachment(attachment.data).then((saved) => {
    if (!saved) savedImages.delete(attachment);
    return saved?.filePath ?? null;
  }).catch((error) => { savedImages.delete(attachment); throw error; });
  savedImages.set(attachment, pending);
  return pending;
}

/** Reject URLs before they can reach local filesystem APIs. Attachments may be
 * extensionless directories; Markdown has already applied its stricter parser. */
export function localChatPath(path: string, cwd: string): string | null {
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (/^file:/i.test(path)) return parseFileRef(path)?.path ?? null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  if (path.startsWith("//")) return null;
  if (isAbsolutePath(path)) return path;
  return cwd && isAbsolutePath(cwd) ? resolveRelativeFromDir(cwd, path) : null;
}

export function useChatFileActions({ chatId, cwd, projectPath }: {
  chatId: string; cwd: string; projectPath?: string;
}) {
  const { t } = useTranslation("panes");
  const lifetime = useMemo(() => ({ active: true }), [chatId, cwd, projectPath]);
  useEffect(() => { lifetime.active = true; return () => { lifetime.active = false; }; }, [lifetime]);

  const captureOrigin = useCallback(() => {
    const state = usePanesStore.getState();
    const origin = state.findTabAcrossLayouts(chatId);
    if (!origin || origin.layoutId !== state.currentLayoutId || origin.panel.activeTabId !== chatId) return null;
    // Panel activates on a bubbling click, after the file's own handler. Capture
    // that same user intent now; subsequent focus changes still cancel the open.
    if (state.activePaneId !== origin.panel.id) state.setActivePane(origin.panel.id);
    return () => {
      const current = usePanesStore.getState();
      const location = current.findTabAcrossLayouts(chatId);
      return lifetime.active && location?.layoutId === origin.layoutId
        && current.currentLayoutId === origin.layoutId && location.panel.id === origin.panel.id
        && location.panel.activeTabId === chatId && current.activePaneId === origin.panel.id ? location : null;
    };
  }, [chatId, lifetime]);

  const report = useCallback((error: unknown) => {
    if (lifetime.active && usePanesStore.getState().findTabAcrossLayouts(chatId)) {
      useAgentChatStore.getState().pushNotice(chatId, t("agentChatOpenAttachmentFailed", { error: translateError(error) }));
    }
  }, [chatId, lifetime, t]);

  const openPath = useCallback(async (path: string, currentOrigin: NonNullable<ReturnType<typeof captureOrigin>>, line?: number) => {
    const absolute = localChatPath(path, cwd);
    if (!absolute) throw new Error(t("agentChatInvalidFile"));
    const entry = await filesystemService.getEntryInfo(absolute);
    const origin = currentOrigin();
    if (!origin) return;
    const state = usePanesStore.getState();
    state.setActivePane(origin.panel.id);
    const title = absolute.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || absolute;
    if (entry.isDir) state.openFileExplorer(absolute, title);
    else {
      const parent = absolute.replace(/[\\/][^\\/]+$/, "");
      const directory = /^[a-z]:$/i.test(parent) ? `${parent}${absolute[2]}` : parent || "/";
      state.openEditor(projectPath || cwd || directory, absolute, title, undefined, { forcePaneTab: true });
      if (line !== undefined) useEditorRevealStore.getState().request(absolute, line, 1);
    }
  }, [captureOrigin, cwd, projectPath, t]);

  const openLocation = useCallback((path: string, line?: number) => {
    const origin = captureOrigin();
    if (origin) void openPath(path, origin, line).catch(report);
  }, [captureOrigin, openPath, report]);

  const openAttachment = useCallback<OpenChatAttachment>(async (attachment) => {
    const origin = captureOrigin();
    if (!origin) return true;
    try {
      if (attachment.path) { await openPath(attachment.path, origin); return true; }
      if (attachment.isDirectory || attachment.kind === "file" || !attachment.data
        || !/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(attachment.mimeType || "image/png")) throw new Error(t("agentChatInvalidFile"));
      if (!isTauriRuntime()) return false;
      if (attachment.data.length > MAX_IMAGE_BASE64) throw new Error(t("agentChatImageTooLarge"));
      const path = await persistImage(attachment);
      if (path && origin()) await openPath(path, origin);
      return Boolean(path);
    } catch (error) { savedImages.delete(attachment); report(error); return true; }
  }, [captureOrigin, openPath, report, t]);

  return { openLocation, openAttachment };
}
