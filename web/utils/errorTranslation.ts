import i18n from "@/i18n";
import type { TerminalLaunchError } from "@/types";

/**
 * 后端错误结构（AppError 序列化后的格式）
 */
interface BackendError {
  code: string;
  message: string;
  params?: Record<string, string>;
}

/**
 * 判断是否为 BackendError 结构
 */
function isBackendError(obj: unknown): obj is BackendError {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "code" in obj &&
    typeof (obj as BackendError).code === "string" &&
    "message" in obj &&
    typeof (obj as BackendError).message === "string"
  );
}

/**
 * 根据错误码查找 i18n 翻译
 */
function translateByCode(code: string, message: string, params?: Record<string, string>): string {
  const key = `errors:${code}`;
  if (i18n.exists(key)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return i18n.t(key as any, params ?? {});
  }
  return message;
}

/**
 * 尝试解析后端错误并翻译为用户友好消息
 *
 * Tauri invoke 的 catch 块收到的 error 可能是：
 * 1. 结构化的 BackendError 对象 `{ code, message, params? }`（新 AppError 格式）
 * 2. BackendError JSON 字符串（旧格式 / serde_json::json!().to_string()）
 * 3. 纯文本错误消息
 * 4. Error 实例
 *
 * @param error - catch 块中的错误对象
 * @returns 翻译后的用户友好错误消息
 */
export function translateError(error: unknown): string {
  // 1. 直接就是 BackendError 对象（Tauri 2 直接序列化 AppError 的情况）
  if (isBackendError(error)) {
    return translateByCode(error.code, error.message, error.params);
  }

  // 2. 对象有 message 字段但无 code（旧 AppError 或内嵌 JSON）
  if (typeof error === "object" && error !== null && "message" in error) {
    const msg = String((error as { message: unknown }).message);
    // message 字段本身可能是 JSON（旧的 serde_json::json!().to_string() 模式）
    try {
      const parsed: BackendError = JSON.parse(msg);
      if (parsed.code) {
        return translateByCode(parsed.code, parsed.message, parsed.params);
      }
    } catch {
      // 不是 JSON，直接使用
    }
    return msg;
  }

  // 3. 字符串（可能是 JSON 也可能是纯文本）
  const errorStr = typeof error === "string" ? error : String(error);
  try {
    const parsed: BackendError = JSON.parse(errorStr);
    if (parsed.code) {
      return translateByCode(parsed.code, parsed.message, parsed.params);
    }
  } catch {
    // 不是 JSON
  }

  return errorStr;
}

/**
 * 提取后端错误码（跨 Tauri / REST 两条通道）
 *
 * - Tauri：AppError 序列化为 `{ code, message, params? }` 对象
 * - REST：`service_error` 用 Display 输出纯文本 `[CODE] message`
 *
 * @returns 错误码（如 "TRASH_FAILED"），无法识别时返回 null
 */
export function getErrorCode(error: unknown): string | null {
  if (isBackendError(error)) {
    return error.code;
  }

  let msg: string;
  if (typeof error === "object" && error !== null && "message" in error) {
    msg = String((error as { message: unknown }).message);
  } else if (typeof error === "string") {
    msg = error;
  } else {
    msg = String(error);
  }

  try {
    const parsed: BackendError = JSON.parse(msg);
    if (parsed.code) {
      return parsed.code;
    }
  } catch {
    // 不是 JSON
  }

  const prefixed = /^\[([A-Z0-9_]+)\]/.exec(msg);
  return prefixed ? prefixed[1] : null;
}

export function toTerminalLaunchError(error: unknown): TerminalLaunchError {
  if (isBackendError(error)) {
    return {
      code: error.code,
      message: error.message,
      params: error.params,
    };
  }

  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as BackendError;
      if (isBackendError(parsed)) return toTerminalLaunchError(parsed);
    } catch {
      // Plain REST error text is handled below.
    }
  }

  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
  return {
    code: getErrorCode(error) ?? undefined,
    message,
  };
}
