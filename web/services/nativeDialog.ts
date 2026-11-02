import { ask } from "@tauri-apps/plugin-dialog";
import { handleErrorSilent } from "@/utils";
import { isTauriRuntime } from "./runtime";

export interface NativeConfirmOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

/**
 * 确认框：桌面走系统对话框，Web 壳回退到浏览器确认框。
 * 只适合纯文字 + 两个按钮；要列清单、多个动作的确认仍用 Dialog。
 */
export async function nativeConfirm(
  message: string,
  { kind = "warning", ...options }: NativeConfirmOptions = {},
): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      return await ask(message, { kind, ...options });
    } catch (error) {
      handleErrorSilent(error, "native confirm");
    }
  }
  return window.confirm(message);
}
