import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import { screenshotService } from "@/services";
import { getErrorMessage } from "@/utils";

export type TerminalPastePayload =
  | { kind: "image"; text: string; filePath: string }
  | { kind: "text"; text: string }
  | { kind: "none" }
  | {
      kind: "error";
      reason: "clipboard-image-unavailable" | "clipboard-image-save-failed";
      error: string;
    };

export function clipboardHasImage(clipboardData?: DataTransfer | null): boolean {
  if (!clipboardData?.items) return false;
  return Array.from(clipboardData.items).some(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );
}

export async function readClipboardText(textHint?: string | null): Promise<string> {
  if (textHint) return textHint;

  const webClipboard = navigator.clipboard;
  if (webClipboard?.readText) {
    try {
      const text = await webClipboard.readText();
      if (text) return text;
    } catch {
      // Fall through to the Tauri clipboard plugin when the Web API is unavailable.
    }
  }

  try {
    return await tauriReadText();
  } catch {
    return "";
  }
}

export async function resolveTerminalPastePayload(
  clipboardData?: DataTransfer | null
): Promise<TerminalPastePayload> {
  const imageHint = clipboardHasImage(clipboardData);

  if (imageHint || !clipboardData) {
    try {
      const savedImage = await screenshotService.saveClipboardImage();
      if (savedImage) {
        return {
          kind: "image",
          text: savedImage.filePath,
          filePath: savedImage.filePath,
        };
      }
      if (imageHint) {
        return {
          kind: "error",
          reason: "clipboard-image-unavailable",
          error: "Clipboard image could not be read",
        };
      }
    } catch (error) {
      return {
        kind: "error",
        reason: "clipboard-image-save-failed",
        error: getErrorMessage(error),
      };
    }
  }

  const text = await readClipboardText(clipboardData?.getData("text/plain"));
  if (text) {
    return {
      kind: "text",
      text,
    };
  }

  return { kind: "none" };
}
