// 窗格空态的共享件：密度分档 + CLI 图标/配色 + 壁纸下的可读底。
//
// 为什么要分档：空态是 `absolute inset-0` 铺满窗格的，而窗格可以被拖到很窄。
// 原来固定 `max-w-xl` + `grid-cols-3` 的三卡在半宽窗格里会挤成一坨，
// 所以按**窗格宽度**（不是视口）三档降级。
//
// 为什么要自带底：`Panel.tsx` 的空态底色读 `--app-panel-bg-effective`，
// 而 `MainViewSwitcher.tsx` 在壁纸激活时把该 token 强制成 transparent
// （同时把 --app-glass-blur 交给壁纸设置接管，默认 0）。于是空态在壁纸下
// 完全没有 scrim，只剩壁纸自己的全局 dim（可以为 0）→ 文字糊成一片。
// 解法是给内容块自己加一层磨砂玻璃底（半透明 + backdrop-blur），**不是**调亮文字色
// （docs/46-frontend-styleguide.md:115 禁止自调透明度造低对比灰字）。
import { useCallback, useRef, useState } from "react";
import { Terminal } from "lucide-react";
import CliBrandIcon from "@/components/CliBrandIcon";
import { CLI_TOOL_TABS } from "@/types/provider";
import { useWallpaperStore } from "@/stores";

/** 窄于此值只留图标按钮 */
export const EMPTY_STATE_MINI_MAX_WIDTH = 260;
/** 窄于此值收成单列命令行，宽于等于此值给完整三卡 */
export const EMPTY_STATE_COMPACT_MAX_WIDTH = 480;

export type EmptyStateDensity = "full" | "compact" | "mini";

export function resolveEmptyStateDensity(width: number): EmptyStateDensity {
  if (width < EMPTY_STATE_MINI_MAX_WIDTH) return "mini";
  if (width < EMPTY_STATE_COMPACT_MAX_WIDTH) return "compact";
  return "full";
}

/**
 * 观测容器宽度得出密度档。
 *
 * 用 callback ref 而不是 useRef + useEffect([])：空态是条件渲染的，
 * 标签来回切会让它反复挂载/卸载，`[]` 依赖的 effect 只会接线一次，
 * 重挂之后就再也观测不到了。
 */
export function useEmptyStateDensity<T extends HTMLElement>(): {
  attachRef: (el: T | null) => void;
  density: EmptyStateDensity;
} {
  const [density, setDensity] = useState<EmptyStateDensity>("full");
  const observerRef = useRef<ResizeObserver | null>(null);

  const attachRef = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;

    // 宽度 0 = 还没排版（首帧、jsdom、display:none 的隐藏布局），
    // 不是「窗格很窄」。当成未知保持上一档，否则内容会先闪一下 mini。
    const apply = (width: number) => {
      if (!(width > 0)) return;
      const next = resolveEmptyStateDensity(width);
      setDensity((prev) => (prev === next ? prev : next));
    };
    apply(el.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      apply(typeof width === "number" ? width : el.clientWidth);
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return { attachRef, density };
}

/**
 * 壁纸激活时给空态内容块的底。未激活返回 undefined（保持今天的外观，不引入回归）。
 * 写法对齐 `Panel.tsx` 全屏退出 chip——仓库里唯一一处在壁纸上保住对比度的先例。
 */
export function useEmptyStateSurfaceStyle(): React.CSSProperties | undefined {
  const wallpaperActive = useWallpaperStore(
    (s) => s.resolved !== null && s.assetUrl !== null,
  );
  if (!wallpaperActive) return undefined;
  return {
    // 半透明底 + 高斯模糊 = 磨砂玻璃：壁纸的色调/构图还能透出来，
    // 但高频细节被模糊掉，文字仍有足够 scrim。
    // 不要写成不透明的 `var(--app-overlay)`——那样 backdrop-filter 等于白做。
    background: "color-mix(in srgb, var(--app-overlay) 58%, transparent)",
    border: "1px solid color-mix(in srgb, var(--app-text-primary) 12%, transparent)",
    borderRadius: "var(--radius-lg, 12px)",
    boxShadow: "var(--sh-lg), var(--hi)",
    backdropFilter: "blur(28px) saturate(140%)",
    WebkitBackdropFilter: "blur(28px) saturate(140%)",
  };
}

/** 空态里的 CLI 图标：已知 CLI 用品牌标（与新标签页一致），纯终端用终端图标。 */
export function CliIcon({ cliTool, className }: { cliTool?: string; className?: string }) {
  if (cliTool === "none" || !cliTool) return <Terminal className={className} aria-hidden="true" />;
  return <CliBrandIcon cliTool={cliTool} className={className} />;
}

/** 图标底块：统一中性底，不再按 CLI 着色——品牌标本身就能区分，彩色底块会和强调色抢视线。 */
export const ICON_TILE_CLASS =
  "flex shrink-0 items-center justify-center rounded-md bg-[var(--app-hover)] text-[var(--app-text-secondary)] "
  + "transition-colors duration-[var(--dur-fast)] group-hover:text-[var(--app-text-primary)]";

/** 小节标题：与新标签页（NewTabPage）同一写法。 */
export const SECTION_HEADING_CLASS = "mb-2 text-xs font-medium text-[var(--app-text-tertiary)]";

/** 列表行：与新标签页「工具」行同一写法——无边框，悬停才出底色。 */
export const LIST_ROW_CLASS =
  "group flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] "
  + "hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]";

/** 运行环境标注（WSL / SSH），本地不标。 */
export function RuntimeBadge({ runtimeKind }: { runtimeKind?: string }) {
  if (runtimeKind !== "wsl" && runtimeKind !== "ssh") return null;
  const color = runtimeKind === "wsl" ? "var(--app-identity-wsl)" : "var(--app-identity-ssh)";
  return (
    <span
      className="shrink-0 rounded px-1.5 py-px text-[length:var(--text-nano)] font-semibold"
      style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
    >
      {runtimeKind.toUpperCase()}
    </span>
  );
}

/** 启动清单 / 会话卡片里的 CLI 显示名 */
export function cliDisplayName(cliTool: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (cliTool === "claude") return "Claude Code";
  if (cliTool === "codex") return "Codex";
  const tab = CLI_TOOL_TABS.find((item) => item.id === cliTool);
  return tab ? t(tab.labelKey, { ns: "settings" }) : cliTool;
}
