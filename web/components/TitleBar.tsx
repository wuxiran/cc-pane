import { Minus, Square, Copy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBorderlessStore } from "@/stores";
import { useWindowControl } from "@/hooks/useWindowControl";

interface TitleBarProps {
  workspaceName?: string;
}

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
// Linux/WebKitGTK 原生支持 -webkit-app-region，但对 drag 区域内的 no-drag 子区域
// 识别有缺陷：父级标题栏设为 drag 后，右上角窗口控制按钮（关闭/最小化/最大化）
// 会收不到点击事件（Ubuntu 上表现为点关闭按钮没反应）。因此 Linux 下不使用
// -webkit-app-region，改为仅依赖 data-tauri-drag-region 实现拖拽（其按 target
// 命中判断，不会拦截按钮点击）。参考同类 Linux WebKit 适配 isLinuxWebKitImeEnvironment。
const isLinux = navigator.platform.toUpperCase().indexOf("LINUX") >= 0;

export default function TitleBar({ workspaceName }: TitleBarProps) {
  const { t } = useTranslation("common");
  const isBorderless = useBorderlessStore((s) => s.isBorderless);
  const {
    closeWindow,
    minimizeWindow,
    maximizeWindow,
    toggleFullscreenWindow,
    isMaximized,
    startDrag,
  } = useWindowControl();

  // 无边框模式时隐藏标题栏
  if (isBorderless) return null;

  return (
    <div
      className="relative flex items-center h-[32px] shrink-0 select-none z-10"
      data-tauri-drag-region=""
      style={{
        paddingLeft: isMac ? 78 : 12,
        paddingRight: 12,
        background: "var(--app-menubar)",
        borderBottom: "1px solid var(--app-border)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
        // Linux 下省略 -webkit-app-region（详见文件顶部 isLinux 说明），避免吞掉窗口控制按钮的点击
        ...(isLinux ? {} : { WebkitAppRegion: "drag" }),
      } as React.CSSProperties}
    >
      {/* 顶部高光线 */}
      <div
        className="absolute top-0 left-0 right-0 h-px pointer-events-none"
        style={{
          background: "var(--app-titlebar-highlight)",
        }}
      />

      {/* 左侧：工作空间名 */}
      <div
        className="flex items-center gap-2 shrink-0 min-w-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        onDoubleClick={(e) => {
          e.preventDefault();
          toggleFullscreenWindow();
        }}
      >
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ background: "var(--app-accent)", boxShadow: "var(--hi)" }}
        />
        <span
          className="text-[12px] font-semibold truncate max-w-[240px]"
          style={{ color: "var(--app-text-primary)" }}
        >
          {workspaceName || "CC-Panes"}
        </span>
      </div>

      {/* 中间：拖拽区 */}
      <div
        data-testid="titlebar-drag-spacer"
        className="flex-1 h-full cursor-grab"
        onMouseDown={(e) => {
          if (e.button === 0 && e.target === e.currentTarget) {
            if (e.detail >= 2) {
              e.preventDefault();
              toggleFullscreenWindow();
              return;
            }
            e.preventDefault();
            startDrag();
          }
        }}
      />

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
