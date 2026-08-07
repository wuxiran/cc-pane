import { useEffect, useRef, useState } from "react";
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

  return (
    <div
      className="relative flex h-full"
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewClose}
    >
      <UsageStatsHoverPreview open={open} onSourceMenuOpenChange={handleSourceMenuOpenChange} />
      <button
        type="button"
        data-testid="usage-stats-status-button"
        aria-label={t("usage.title")}
        className="flex h-full w-7 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
      >
        <BarChart3 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
