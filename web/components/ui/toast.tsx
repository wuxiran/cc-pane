// 全局瞬时提示（toast）的唯一实现：一份状态 + 一个 <AppToaster />。
//
// 业务代码不直接用这里的 toast，优先走 web/lib/feedback.ts 的 toastOk / toastErr 等；
// 这里的 `toast` 保留给需要 id / action 等细节的调用点。
//
// 定位写成内联样式而不是类名：样式表没生效时，提示也只会没有装饰，不会掉进文档流
// 把整个界面顶下去。
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export type ToastKind = "default" | "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: ReactNode;
  onClick: () => void;
}

export interface ToastOptions {
  /** 同一个 id 再次调用会原地更新，不叠加新的一条。 */
  id?: string | number;
  description?: ReactNode;
  /** 毫秒；Infinity 表示不自动消失。 */
  duration?: number;
  action?: ToastAction;
}

export interface ToastItem {
  id: string | number;
  kind: ToastKind;
  message: ReactNode;
  description?: ReactNode;
  duration: number;
  action?: ToastAction;
  /** 同 id 更新时自增，用来重置计时。 */
  revision: number;
}

/** 各类型默认时长（ms）：确认类看完即忘从短，错误要读完原因从长。 */
export const TOAST_DEFAULT_DURATION: Record<ToastKind, number> = {
  default: 4_000,
  success: 3_000,
  info: 4_000,
  warning: 5_000,
  error: 6_000,
};

/** 同时最多显示几条；更早的先被挤掉。 */
export const TOAST_MAX_VISIBLE = 4;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: ToastItem[]) {
  items = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return items;
}

function push(kind: ToastKind, message: ReactNode, options: ToastOptions = {}): string | number {
  const id = options.id ?? `toast-${nextId++}`;
  const existing = items.find((item) => item.id === id);
  const next: ToastItem = {
    id,
    kind,
    message,
    description: options.description,
    duration: options.duration ?? TOAST_DEFAULT_DURATION[kind],
    action: options.action,
    revision: (existing?.revision ?? 0) + 1,
  };
  if (existing) {
    emit(items.map((item) => (item.id === id ? next : item)));
  } else {
    emit([...items, next].slice(-TOAST_MAX_VISIBLE));
  }
  return id;
}

function dismiss(id?: string | number) {
  if (id === undefined) {
    if (items.length > 0) emit([]);
    return;
  }
  if (items.some((item) => item.id === id)) emit(items.filter((item) => item.id !== id));
}

type ToastFn = (message: ReactNode, options?: ToastOptions) => string | number;

export const toast: ToastFn & {
  success: ToastFn;
  error: ToastFn;
  warning: ToastFn;
  info: ToastFn;
  dismiss: (id?: string | number) => void;
} = Object.assign((message: ReactNode, options?: ToastOptions) => push("default", message, options), {
  success: (message: ReactNode, options?: ToastOptions) => push("success", message, options),
  error: (message: ReactNode, options?: ToastOptions) => push("error", message, options),
  warning: (message: ReactNode, options?: ToastOptions) => push("warning", message, options),
  info: (message: ReactNode, options?: ToastOptions) => push("info", message, options),
  dismiss,
});

/** 测试用：读当前队列 / 清空。 */
export function getToasts(): readonly ToastItem[] {
  return items;
}

const KIND_STYLE: Record<ToastKind, { color: string | null; icon: ReactNode }> = {
  default: { color: null, icon: null },
  success: { color: "var(--app-status-success)", icon: <CheckCircle2 aria-hidden="true" size={15} /> },
  error: { color: "var(--app-status-danger)", icon: <XCircle aria-hidden="true" size={15} /> },
  warning: { color: "var(--app-status-warning)", icon: <AlertTriangle aria-hidden="true" size={15} /> },
  info: { color: "var(--app-accent)", icon: <Info aria-hidden="true" size={15} /> },
};

interface AppToasterProps {
  /** 距窗口底边的距离（px）。主窗口要抬到 StatusBar 上方。 */
  offset?: number;
}

/** 每个窗口挂一个。底部居中：右下是通知中心栈，顶部是标题栏。 */
export function AppToaster({ offset = 16 }: AppToasterProps) {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { t } = useTranslation("common");
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      data-testid="app-toaster"
      aria-label={t("toastRegion")}
      role="region"
      style={{
        position: "fixed",
        left: "50%",
        bottom: offset,
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        width: "min(420px, calc(100vw - 32px))",
        pointerEvents: "none",
      }}
    >
      {list.map((item) => (
        <ToastRow key={item.id} item={item} closeLabel={t("close")} />
      ))}
    </div>,
    document.body,
  );
}

function ToastRow({ item, closeLabel }: { item: ToastItem; closeLabel: string }) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(item.duration);
  const revisionRef = useRef(item.revision);

  // 同 id 更新：重新计时。
  if (revisionRef.current !== item.revision) {
    revisionRef.current = item.revision;
    remainingRef.current = item.duration;
  }

  useEffect(() => {
    if (paused || !Number.isFinite(remainingRef.current)) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => dismiss(item.id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [item.id, item.revision, paused]);

  const style = KIND_STYLE[item.kind];
  const urgent = item.kind === "error" || item.kind === "warning";

  return (
    <div
      data-testid="app-toast"
      data-kind={item.kind}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      style={{ pointerEvents: "auto", maxWidth: "100%" }}
      className="relative flex items-start gap-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] py-2 pl-3.5 pr-2 shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in motion-safe:duration-[var(--dur-slow)] motion-safe:ease-[var(--ease-out)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {style.color && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px]" style={{ background: style.color }} />
      )}
      {style.icon && (
        <span className="mt-0.5 flex size-[15px] shrink-0 items-center justify-center" style={{ color: style.color ?? undefined }}>
          {style.icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="break-words text-[length:var(--text-row)] leading-5 text-[var(--app-text-primary)]">{item.message}</div>
        {item.description && (
          <div className="mt-0.5 break-words text-[length:var(--text-caption)] leading-[18px] text-[var(--app-text-secondary)]">
            {item.description}
          </div>
        )}
      </div>
      {item.action && (
        <button
          type="button"
          className="shrink-0 rounded-md border border-[var(--app-border)] px-2 py-0.5 text-[length:var(--text-small)] font-medium text-[var(--app-text-primary)] transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          onClick={() => {
            item.action?.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label={closeLabel}
        className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        onClick={() => dismiss(item.id)}
      >
        <X aria-hidden="true" size={13} />
      </button>
    </div>
  );
}
