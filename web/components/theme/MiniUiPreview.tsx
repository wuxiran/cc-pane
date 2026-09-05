import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/useThemeStore";
import { buildOverrideDeclarations } from "@/theme/themeOverrides";
import { themeGroup, type ThemeId } from "@/theme/themePresets";
import type { ThemeShape } from "@/theme/themeShapes";
import "./miniUiPreview.css";

interface MiniUiPreviewProps {
  /** 主题模式：预览框套 data-theme + 暗色补 .dark，框内 var(--app-*) 解析为该主题色板 */
  theme?: ThemeId;
  /** 形态模式：预览框套 data-shape；缺省跟随 useThemeStore 的当前 shape，
   *  因此主题卡（每张主题不同）会统一呈现用户当前形态 */
  shape?: ThemeShape;
  className?: string;
}

// 终端模拟行：[行内容, 宽度]；首行带 accent 提示符，第二行是成功输出。
const TERMINAL_LINES = [
  { text: "$ pnpm tauri:dev", width: "w-4/5", tone: "prompt" },
  { text: "✓ compiled in 312ms", width: "w-3/5", tone: "success" },
  { text: "ready — waiting…", width: "w-1/2", tone: "dim" },
] as const;

/**
 * 主题/形态卡共用的 mini UI 缩略图：纯 JSX + token 绘制具象界面骨架
 * （顶部主色带 → 侧栏+列表行 → Tab 栏 → 终端区+主按钮）。装饰性，恒 aria-hidden。
 * 颜色全部走 var()，由 .mini-ui-scope[data-theme|data-shape] 作用域解析（见
 * miniUiPreview.css），组件内不出现任何裸色值。
 *
 * 微调联动：useThemeStore.customOverrides 依附的 baseThemeId 与本框解析的
 * 主题一致时，把同一份覆盖声明 inline 到作用域根（穿透 .mini-ui-scope 对
 * documentElement 覆盖的屏蔽），主题卡/形态卡与真实界面同步反映微调。
 */
export function MiniUiPreview({ theme, shape, className }: MiniUiPreviewProps) {
  const currentShape = useThemeStore((state) => state.shape);
  const currentThemeId = useThemeStore((state) => state.themeId);
  const customOverrides = useThemeStore((state) => state.customOverrides);

  const effectiveShape = shape ?? currentShape;
  const resolvedTheme = theme ?? currentThemeId;
  // Record<token, value> → CSSProperties：custom property 键（--*）不在
  // React.CSSProperties 封闭类型内，经 unknown 断言一次（非 any）。
  const overrideStyle = (
    customOverrides && customOverrides.baseThemeId === resolvedTheme
      ? buildOverrideDeclarations(customOverrides)
      : undefined
  ) as unknown as CSSProperties | undefined;

  const scopeProps = {
    ...(theme ? { "data-theme": theme } : {}),
    "data-shape": effectiveShape,
  };

  return (
    <span
      aria-hidden="true"
      {...scopeProps}
      className={cn(
        "mini-ui-scope mini-ui-panel relative block aspect-video w-full overflow-hidden",
        theme && themeGroup(theme) === "dark" && "dark",
        className,
      )}
      style={{ background: "var(--app-bg-deep)", ...overrideStyle }}
    >
      {/* 4px 主题主色带（卡顶） */}
      <span
        data-accent-band
        className="block h-1 w-full shrink-0"
        style={{ background: "var(--primary)" }}
      />
      <span className="flex h-[calc(100%-0.25rem)]">
        {/* 左 1/4 侧栏：两行普通列表行 + 一行选中行 */}
        <span
          className="mini-ui-surface flex w-1/4 flex-col gap-1 border-r p-1.5"
          style={{ background: "var(--app-sidebar)", borderColor: "var(--app-border)" }}
        >
          <span className="h-1 w-3/4 rounded-full opacity-70" style={{ background: "var(--app-text-secondary)" }} />
          <span
            className="mini-ui-control flex items-center gap-1 px-0.5 py-1"
            style={{ background: "var(--app-active-bg)" }}
          >
            <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: "var(--app-accent)" }} />
            <span className="h-1 w-full rounded-full" style={{ background: "var(--app-text-primary)" }} />
          </span>
          <span className="h-1 w-2/3 rounded-full opacity-50" style={{ background: "var(--app-text-secondary)" }} />
        </span>

        {/* 右侧：Tab 栏 + 终端区 */}
        <span className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--app-content)" }}>
          <span
            className="flex h-4 shrink-0 items-end gap-1 border-b px-1.5"
            style={{ background: "var(--app-tabbar)", borderColor: "var(--app-border)" }}
          >
            {/* 活动 Tab：高亮底 + accent 下划线 + 实色标题条 */}
            <span
              className="mini-ui-control relative flex h-3.5 w-1/3 items-center px-1"
              style={{ background: "var(--app-tab-highlight)" }}
            >
              <span className="h-0.5 w-full rounded-full" style={{ background: "var(--app-text-primary)" }} />
              <span
                className="absolute inset-x-0 bottom-0 h-px"
                style={{ background: "var(--app-accent)" }}
              />
            </span>
            {/* 非活动 Tab */}
            <span className="flex h-3.5 w-1/4 items-center px-1 opacity-70">
              <span className="h-0.5 w-full rounded-full" style={{ background: "var(--app-text-tertiary)" }} />
            </span>
          </span>

          {/* 终端区：三行等宽模拟输出 + 主色按钮小块 */}
          <span
            className="flex min-h-0 flex-1 flex-col gap-[3px] p-1.5 font-mono"
            style={{ background: "var(--app-terminal-bg)" }}
          >
            {TERMINAL_LINES.map((line) => (
              <span
                key={line.text}
                className={cn("block truncate text-left text-[5px] leading-none", line.width)}
                style={{
                  color: line.tone === "success"
                    ? "var(--app-status-success)"
                    : line.tone === "dim"
                      ? "var(--app-text-tertiary)"
                      : "var(--app-terminal-fg)",
                }}
              >
                {line.tone === "prompt" && (
                  <span style={{ color: "var(--app-accent)" }}>$ </span>
                )}
                {line.text.replace(/^\$ /, "")}
              </span>
            ))}
            <span
              className="mini-ui-control mt-auto flex h-2.5 w-7 items-center justify-center"
              style={{ background: "var(--primary)" }}
            >
              <span className="h-0.5 w-4 rounded-full" style={{ background: "var(--primary-foreground)" }} />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}
