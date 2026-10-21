import type { AgentChatAttachment } from "@/types/agentChat";
import { toAssetUrl } from "@/utils/assetUrl";
import { isImagePath } from "./chatAttachments";
import { isAbsolutePath } from "./chatPaths";

/** Legacy attachments omit kind. Only raster data and local absolute files become
 * image sources: resource links and arbitrary remote URLs remain file cards. */
export function chatAttachmentPreview(attachment: AgentChatAttachment): string | null {
  if (attachment.isDirectory) return null;
  if (attachment.kind !== "file" && attachment.data) {
    const mime = attachment.mimeType || "image/png";
    return /^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(mime)
      ? `data:${mime};base64,${attachment.data}` : null;
  }
  if (attachment.path && isAbsolutePath(attachment.path) && isImagePath(attachment.path)) {
    return toAssetUrl(attachment.path);
  }
  return null;
}
