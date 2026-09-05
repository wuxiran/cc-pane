// 反馈通道统一封装：toast 一律走这里，业务不裸调 sonner 的 toast()。
// 通道判定矩阵（toast / 通知中心 / Banner / inline）见 docs/feedback-channels.md。
import type { ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";
import { normalizeNotification, useNotificationStore } from "@/stores/useNotificationStore";

/** 主窗口 Toaster 位置：底部居中——右下是通知中心栈，顶部有 TitleBar/Banner。 */
export const TOASTER_POSITION = "bottom-center" as const;
/** StatusBar 高 28px（h-[28px]）+ 1px 边框，40px 留出约 11px 视觉间距。 */
export const TOASTER_OFFSET_MAIN = { bottom: 40 } as const;
/** ccchan 浮窗没有 StatusBar，贴底留小边距即可。 */
export const TOASTER_OFFSET_CCCHAN = { bottom: 12 } as const;

/** 统一时长（ms）：确认类看完即忘从短，错误要读完原因从长。 */
export const TOAST_DURATION_OK = 3_000;
export const TOAST_DURATION_INFO = 4_000;
export const TOAST_DURATION_WARN = 5_000;
export const TOAST_DURATION_ERR = 6_000;

/** 瞬时操作成功确认（保存成功、已复制等）。 */
export function toastOk(message: ReactNode, options?: ExternalToast): string | number {
  return toast.success(message, { duration: TOAST_DURATION_OK, ...options });
}

/** 一般提示（非成功也非错误）。 */
export function toastInfo(message: ReactNode, options?: ExternalToast): string | number {
  return toast.info(message, { duration: TOAST_DURATION_INFO, ...options });
}

/** 降级/警告（操作完成但有注意事项）。 */
export function toastWarn(message: ReactNode, options?: ExternalToast): string | number {
  return toast.warning(message, { duration: TOAST_DURATION_WARN, ...options });
}

/** 同步操作失败。需要翻译后端错误 + 写日志时仍走 handleError。 */
export function toastErr(message: ReactNode, options?: ExternalToast): string | number {
  return toast.error(message, { duration: TOAST_DURATION_ERR, ...options });
}

export interface NotifyAsyncInput {
  title: string;
  body?: string;
  /** 分类 kind，决定严重度与自动消失策略（见 lib/notificationTaxonomy.ts）。 */
  kind?: string;
  source?: string;
  sessionId?: string;
  requiresInput?: boolean;
  /** false = 只入历史不弹卡片（agent 忙时的静默事件）。 */
  showCard?: boolean;
}

/**
 * 需要可回看/可操作的异步事件 → 通知中心（历史 + 右下卡片栈）。
 * 返回通知 id，可用于后续 dismiss/markRead。
 */
export function notifyAsync(input: NotifyAsyncInput): string {
  const record = normalizeNotification({
    title: input.title,
    body: input.body,
    kind: input.kind,
    source: input.source,
    sessionId: input.sessionId,
    requiresInput: input.requiresInput,
  });
  const store = useNotificationStore.getState();
  store.add(record);
  if (input.showCard !== false) store.showToast(record.id);
  return record.id;
}
