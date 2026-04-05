export { formatRelativeTime, formatFullTime, formatSize } from "./format";
export { getFileName, getDirName, getProjectName, toWslPath } from "./path";
export {
  buildSshConnectionDisplayPath,
  buildSshDisplayPath,
  detectAppPlatform,
  getWorkspaceDefaultEnvironment,
  getWorkspaceEnvironmentIssue,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  getWorkspaceProjectKind,
  resolveWorkspaceProjectWslPath,
  resolveWorkspaceLaunchOptions,
} from "./workspaceLaunch";
export { parseEnvLines, formatEnvLines } from "./env";
export { handleError, handleErrorSilent } from "./errorHandler";
export { translateError } from "./errorTranslation";

/**
 * 从 catch 到的未知错误中提取可读消息。
 * Tauri IPC 返回的 AppError 结构为 `{ message: "..." }`，
 * 直接 `String(e)` 会得到 `[object Object]`。
 */
export function getErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** Tauri IPC 桥接是否已注入（在 Tauri webview 内运行时为 true） */
export function isTauriReady(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * 等待 Tauri IPC 桥接就绪（最多等待 5 秒）。
 * 在 HMR 热重载时 IPC 可能短暂不可用，此函数会轮询等待。
 */
export function waitForTauri(timeoutMs = 5000): Promise<boolean> {
  if (isTauriReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (isTauriReady()) {
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        resolve(false);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}
