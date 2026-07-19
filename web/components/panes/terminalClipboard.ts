import { invoke } from "@tauri-apps/api/core";
import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";
import { screenshotService } from "@/services";
import { getErrorMessage } from "@/utils";
import { isTauriRuntime } from "@/services/runtime";
import { devDebugLog } from "@/utils/devLogger";

export type TerminalPastePayload =
  | { kind: "image"; text: string; filePath: string }
  | { kind: "file"; text: string; filePaths: string[] }
  | { kind: "text"; text: string }
  | { kind: "none" }
  | {
      kind: "error";
      reason: "clipboard-image-unavailable" | "clipboard-image-save-failed";
      error: string;
    };

export interface ClipboardFilePathsResult {
  paths: string[];
  error?: string;
}

export function clipboardHasImage(clipboardData?: DataTransfer | null): boolean {
  if (!clipboardData?.items) return false;
  return Array.from(clipboardData.items).some(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );
}

export async function readClipboardText(textHint?: string | null): Promise<string> {
  if (textHint) {
    devDebugLog("terminal-clipboard", "text.read", {
      source: "clipboard-event",
      textLength: textHint.length,
    });
    return textHint;
  }

  if (isTauriRuntime()) {
    try {
      const text = await tauriReadText();
      devDebugLog("terminal-clipboard", "text.read", {
        source: "tauri-plugin",
        textLength: text.length,
      });
      return text;
    } catch {
      devDebugLog("terminal-clipboard", "text.read.failed", {
        source: "tauri-plugin",
      });
      return "";
    }
  }

  const webClipboard = navigator.clipboard;
  if (webClipboard?.readText) {
    try {
      const text = await webClipboard.readText();
      devDebugLog("terminal-clipboard", "text.read", {
        source: "web-clipboard",
        textLength: text.length,
      });
      if (text) return text;
    } catch {
      devDebugLog("terminal-clipboard", "text.read.failed", {
        source: "web-clipboard",
      });
      return "";
    }
  }

  return "";
}

export function formatTerminalFilePaths(paths: string[]): string {
  return paths.filter((path) => path.length > 0).join(" ");
}

export async function readClipboardFilePaths(): Promise<ClipboardFilePathsResult> {
  try {
    if (!isTauriRuntime()) {
      return { paths: [] };
    }
    const paths = await invoke<string[]>("read_clipboard_file_paths");
    return {
      paths: Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === "string" && path.length > 0)
        : [],
    };
  } catch (error) {
    const message = getErrorMessage(error);
    if (import.meta.env.DEV) {
      console.debug("[terminalClipboard] clipboard.file-paths.failed", { error: message });
    }
    return {
      paths: [],
      error: message,
    };
  }
}

export async function resolveTerminalPastePayload(
  clipboardData?: DataTransfer | null
): Promise<TerminalPastePayload> {
  const filePathsResult = await readClipboardFilePaths();
  const fileText = formatTerminalFilePaths(filePathsResult.paths);
  if (fileText) {
    return {
      kind: "file",
      text: fileText,
      filePaths: filePathsResult.paths,
    };
  }

  const imageHint = clipboardHasImage(clipboardData);

  // Image probing is a best-effort side path: on Linux the backend reads the
  // clipboard image off the main thread (GTK/arboard), which can reject the
  // invoke outright. A failure here must never prevent a plain text paste, so
  // the error is remembered and only surfaced when there is no text to paste.
  let imageError: string | null = null;

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
    } catch (error) {
      imageError = getErrorMessage(error);
      devDebugLog("terminal-clipboard", "image.probe.failed", {
        error: imageError,
      });
    }
  }

  const text = await readClipboardText(clipboardData?.getData("text/plain"));
  if (text) {
    return {
      kind: "text",
      text,
    };
  }

  if (imageError) {
    return {
      kind: "error",
      reason: "clipboard-image-save-failed",
      error: imageError,
    };
  }

  if (imageHint) {
    return {
      kind: "error",
      reason: "clipboard-image-unavailable",
      error: "Clipboard image could not be read",
    };
  }

  return { kind: "none" };
}
