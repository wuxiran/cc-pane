export { formatRelativeTime, formatFullTime, formatSize } from "./format";
export { getFileName, getDirName, getProjectName, toWslPath, isWslUncPath } from "./path";
export {
  buildSshConnectionDisplayPath,
  buildSshDisplayPath,
  classifyTerminalLaunchPath,
  detectAppPlatform,
  hasWorkspaceWslPath,
  getWorkspaceDefaultEnvironment,
  getWorkspaceEnvironmentIssue,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  getWorkspaceProjectKind,
  resolveCliEnvironmentDefault,
  resolveWorkspaceProjectLaunchOptions,
  resolveWorkspaceProjectWslPath,
  resolveWorkspaceLaunchOptions,
} from "./workspaceLaunch";
export { coerceCliTool } from "./cliTool";
export { buildLaunchRecordTerminalOptions } from "./launchHistory";
export { parseEnvLines, formatEnvLines } from "./env";
export { handleError, handleErrorSilent } from "./errorHandler";
export { translateError, getErrorCode, toTerminalLaunchError } from "./errorTranslation";
export { isTauriRuntime, isWebRuntime } from "@/services/runtime";

/**
 * 从 catch 到的未知错误中提取可读消息。
 * Tauri IPC 返回的 AppError 结构为 `{ message: "..." }`，
 * 直接 `String(e)` 会得到 `[object Object]`。
 */
function parseSerializedMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      return typeof message === "string" ? message : null;
    }
  } catch {
    // Keep the original response when it is not JSON.
  }
  return null;
}

function formatUnknownError(value: unknown, seen: Set<object>): string {
  if (typeof value === "string") return parseSerializedMessage(value) ?? value;
  if (value instanceof Error) return parseSerializedMessage(value.message) ?? value.message;
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "Unknown error";
    seen.add(value);
    const record = value as Record<string, unknown>;
    // Tauri and HTTP bridges use slightly different envelopes. Prefer a
    // nested message/detail over rendering the object as "[object Object]".
    for (const key of ["message", "error", "detail"]) {
      if (!(key in record) || record[key] === value) continue;
      const nested = formatUnknownError(record[key], seen);
      if (nested && nested !== "Unknown error" && nested !== "[object Object]") return nested;
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Circular error objects fall through to the stable fallback below.
    }
    return "Unknown error";
  }
  const fallback = String(value);
  return fallback === "[object Object]" ? "Unknown error" : fallback;
}

export function getErrorMessage(e: unknown): string {
  return formatUnknownError(e, new Set<object>());
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
