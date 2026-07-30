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
// 解法是给内容块自己加一层底，**不是**调亮文字色
// （docs/46-frontend-styleguide.md:115 禁止自调透明度造低对比灰字）。
import { useCallback, useRef, useState } from "react";
import { Bot, Sparkles, Terminal } from "lucide-react";
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
    background: "var(--app-overlay)",
    border: "1px solid var(--app-border)",
    borderRadius: "var(--radius-lg, 12px)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
  };
}

export function CliIcon({ cliTool, className }: { cliTool?: string; className?: string }) {
  if (cliTool === "codex") return <Bot className={className} />;
  if (cliTool === "none" || !cliTool) return <Terminal className={className} />;
  return <Sparkles className={className} />;
}

export function iconTileStyle(cliTool?: string): React.CSSProperties {
  if (cliTool === "codex") {
    return {
      background: "color-mix(in srgb, var(--app-status-success) 13%, transparent)",
      color: "var(--app-status-success)",
    };
  }
  if (cliTool === "none" || !cliTool) {
    return { background: "var(--app-hover)", color: "var(--app-text-tertiary)" };
  }
  return {
    background: "color-mix(in srgb, var(--app-accent) 13%, transparent)",
    color: "var(--app-accent)",
  };
}
