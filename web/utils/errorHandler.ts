import { toast } from "sonner";
import { translateError } from "./errorTranslation";

/**
 * 统一错误处理入口
 *
 * 职责：
 * 1. 通过 translateError 将后端错误翻译为用户友好消息
 * 2. 用 toast 显示错误通知
 * 3. 在控制台记录错误详情（含原始错误对象）
 *
 * @param error - catch 块中的错误对象
 * @param context - 可选上下文描述（如 "创建工作空间"），仅用于控制台日志
 */
export function handleError(error: unknown, context?: string): void {
  const userMessage = translateError(error);

  if (context) {
    console.error(`[${context}]`, error);
  } else {
    console.error(error);
  }

  toast.error(userMessage);
}

/**
 * 静默处理错误（仅记录日志，不弹 toast）
 *
 * 用于非关键操作（如窗口置顶、后台刷新等），
 * 失败不影响用户体验的场景。
 */
export function handleErrorSilent(error: unknown, context?: string): void {
  if (context) {
    console.error(`[${context}]`, error);
  } else {
    console.error(error);
  }
}
