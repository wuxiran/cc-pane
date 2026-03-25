import { Minus, Square, Copy, X, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBorderlessStore } from "@/stores";
import { useWindowControl } from "@/hooks/useWindowControl";

interface TitleBarProps {
  workspaceName?: string;
  onOpenQuickSearch?: () => void;
}

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

export default function TitleBar({ workspaceName, onOpenQuickSearch }: TitleBarProps) {
  const { t } = useTranslation("common");
  const isBorderless = useBorderlessStore((s) => s.isBorderless);
  const { closeWindow, minimizeWindow, maximizeWindow, isMaximized, startDrag } = useWindowControl();

  // 无边框模式时隐藏标题栏
  if (isBorderless) return null;

  return (
    <div
      className="relative flex items-center h-[32px] shrink-0 select-none z-10"
      style={{
        paddingLeft: isMac ? 78 : 12,
        paddingRight: 12,
        background: "var(--app-menubar)",
        borderBottom: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
      }}
    >
      {/* 顶部高光线 */}
      <div
        className="absolute top-0 left-0 right-0 h-px pointer-events-none"
        style={{
          background: "var(--app-titlebar-highlight)",
        }}
      />

      {/* 左侧：工作空间名 */}
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <span
          className="text-[12px] font-medium truncate max-w-[200px]"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {workspaceName || "CC-Panes"}
        </span>
      </div>

      {/* 中间：搜索入口 + 拖拽区 */}
      <div
        className="flex-1 h-full flex items-center justify-center cursor-grab"
        data-tauri-drag-region=""
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        onMouseDown={(e) => {
          if (e.button === 0) {
            e.preventDefault();
            startDrag();
          }
        }}
      >
        <button
          className="flex items-center gap-2 w-[420px] max-w-[50vw] h-[22px] px-2.5 rounded-md border text-[12px] transition-colors hover:opacity-90"
          style={{
            background: "var(--app-hover)",
            borderColor: "var(--app-border)",
            color: "var(--app-text-tertiary)",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
          onClick={onOpenQuickSearch}
        >
          <Search size={12} className="shrink-0" />
          <span className="flex-1 text-left truncate">Search files...</span>
          <kbd
            className="text-[10px] px-1 py-0.5 rounded-sm"
            style={{
              background: "var(--app-hover)",
              color: "var(--app-text-tertiary)",
            }}
          >
            Ctrl+P
          </kbd>
        </button>
      </div>

      {/* 右侧：窗口控件（macOS 使用原生红绿灯，不需要自定义按钮） */}
      {!isMac && (
        <div className="flex items-center -mr-1 shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            className="w-[34px] h-[28px] flex items-center justify-center rounded-[4px] transition-colors duration-200 text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
            onClick={minimizeWindow}
            title={t("minimize")}
          >
            <Minus className="w-[13px] h-[13px]" />
          </button>
          <button
            className="w-[34px] h-[28px] flex items-center justify-center rounded-[4px] transition-colors duration-200 text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]"
            onClick={maximizeWindow}
            title={isMaximized ? t("restoreWindow") : t("maximize")}
          >
            {isMaximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
          </button>
          <button
            className="w-[34px] h-[28px] flex items-center justify-center rounded-[4px] transition-colors duration-200 text-[var(--app-text-secondary)] hover:bg-[var(--app-close-btn-hover-bg)] hover:text-[var(--app-close-btn-hover-fg)]"
            onClick={closeWindow}
            title={t("close")}
          >
            <X className="w-[13px] h-[13px]" />
          </button>
        </div>
      )}
    </div>
  );
}
