import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type AlertBannerTone = "warning" | "danger";

/**
 * AppShell 顶部告警横幅的共享外壳（OrchestratorAlertBanner / RestoreRegressionBanner）。
 *
 * 视觉契约：「Refined Developer Tool」——语义 token、发丝边框、克制 elevation：
 * - 色调只走 `--app-status-*-bg/border/fg` 语义 token，不出现裸色值；
 * - 背景是状态色淡罩叠在不透明 `--app-panel-bg` 底上，避免暗色下 10% 状态色
 *   直接罩在深底上发脏；
 * - 只有底部单侧发丝边框 + 内高光 `--hi`，不再用 border-y 色块条夹住内容；
 * - 图标放在状态色 14% color-mix 的圆角小芯片里（tone 由调用方决定）；
 * - 入场动画 transform/opacity only，走 `--dur-fast` + `--ease-out`，
 *   prefers-reduced-motion 由 index.css 的全局规则兜底。
 *
 * role/ariaLive/文案/关闭行为由调用方决定，本壳只负责形态，保证两条横幅同族一致。
 */
const TONE: Record<AlertBannerTone, { fg: string; bg: string; border: string; chip: string }> = {
  warning: {
    fg: "var(--app-status-warning)",
    bg: "var(--app-status-warning-bg)",
    border: "var(--app-status-warning-border)",
    chip: "bg-[color-mix(in_srgb,var(--app-status-warning)_14%,transparent)]",
  },
  danger: {
    fg: "var(--app-status-danger)",
    bg: "var(--app-status-danger-bg)",
    border: "var(--app-status-danger-border)",
    chip: "bg-[color-mix(in_srgb,var(--app-status-danger)_14%,transparent)]",
  },
};

export const alertBannerTitleClass = "m-0 font-medium text-[var(--app-text-primary)]";

export const alertBannerDescClass = "m-0 mt-0.5 text-[11px] text-[var(--app-text-secondary)]";

export const alertBannerCloseButtonClass =
  "shrink-0 rounded-md p-1 text-[var(--app-text-tertiary)] " +
  "transition-[background-color,color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
  "hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] active:scale-[0.96]";

interface AlertBannerShellProps {
  tone: AlertBannerTone;
  role: "alert" | "status";
  ariaLive: "polite" | "assertive";
  /** 状态图标（spin 等动效由调用方自带），渲染进色调芯片。 */
  icon: ReactNode;
  /** 标题行以下的内容（说明、可展开的错误详情等）。 */
  children: ReactNode;
  /** 行尾操作位（如 ghost 关闭按钮）；不传则不占位。 */
  action?: ReactNode;
}

export default function AlertBannerShell({
  tone,
  role,
  ariaLive,
  icon,
  children,
  action,
}: AlertBannerShellProps) {
  const colors = TONE[tone];
  return (
    <section
      role={role}
      aria-live={ariaLive}
      className="relative z-[2] flex shrink-0 animate-in items-start gap-2.5 px-3 py-2 text-xs fade-in-0 slide-in-from-top-1 duration-[var(--dur-fast)] ease-[var(--ease-out)]"
      style={{
        background: `linear-gradient(${colors.bg}, ${colors.bg}), var(--app-panel-bg)`,
        borderBottom: `1px solid ${colors.border}`,
        boxShadow: "var(--hi)",
      }}
    >
      <span
        aria-hidden="true"
        className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", colors.chip)}
        style={{ color: colors.fg }}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </section>
  );
}
