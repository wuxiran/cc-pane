import { useEffect, useRef, useState, type FocusEvent } from "react";
import { BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import UsageStatsHoverPreview from "./UsageStatsHoverPreview";

export default function UsageStatsStatusButton() {
  const { t } = useTranslation("home");
  const [open, setOpen] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  useEffect(() => clearCloseTimer, []);

  const showPreview = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const startCloseTimer = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 320);
  };

  const schedulePreviewClose = () => {
    if (!sourceMenuOpen) startCloseTimer();
  };

  const handleSourceMenuOpenChange = (nextOpen: boolean) => {
    clearCloseTimer();
    setSourceMenuOpen(nextOpen);
    if (nextOpen) {
      setOpen(true);
    } else {
      startCloseTimer();
    }
  };

  // 键盘等价路径：预览此前仅 hover 可达。Enter/空格/↓ 显式打开，Escape 立即关闭。
  // 不做「聚焦即开」：StatusBar「更多工具」Popover 的焦点陷阱会把焦点压到本按钮，
  // 聚焦自动打开会与陷阱来回拉扯（worker 级死循环，实锤于 StatusBar.overflow 测试）。
  // focusout 时 relatedTarget 仍在容器内（预览在容器 DOM 里）则不关，
  // 焦点真正离开容器后按与鼠标一致的 320ms 延时关闭。
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      showPreview();
    } else if (event.key === "Escape") {
      clearCloseTimer();
      setOpen(false);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    schedulePreviewClose();
  };

  return (
    <div
      className="relative flex h-full"
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewClose}
      onBlur={handleBlur}
    >
      <UsageStatsHoverPreview open={open} onSourceMenuOpenChange={handleSourceMenuOpenChange} />
      <button
        type="button"
        data-testid="usage-stats-status-button"
        aria-label={t("usage.title")}
        aria-expanded={open}
        aria-controls="usage-stats-hover-preview"
        onKeyDown={handleKeyDown}
        className="flex h-full w-7 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
      >
        <BarChart3 aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
