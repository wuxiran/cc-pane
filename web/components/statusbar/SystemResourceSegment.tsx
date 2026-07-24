import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { systemStatsService } from "@/services/systemStatsService";
import type { SystemStats } from "@/types";
import { handleErrorSilent } from "@/utils";

const POLL_INTERVAL_MS = 3_000;
const GIB = 1024 ** 3;

function formatGib(bytes: number): string {
  const value = Math.round((bytes / GIB) * 10) / 10;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

export default function SystemResourceSegment() {
  const { t } = useTranslation("common");
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      if (disposed || refreshing || document.hidden) return;
      refreshing = true;
      try {
        const next = await systemStatsService.get();
        if (!disposed && next) setStats(next);
      } catch (error) {
        handleErrorSilent(error, "get system stats");
      } finally {
        refreshing = false;
      }
    };

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer !== null || document.hidden) return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();

    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  if (!stats) return null;

  const cpuPercent = Math.round(stats.cpuPercent);
  const memoryPercent = stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : 0;
  const cpuWarning = stats.cpuPercent > 85;
  const memoryWarning = memoryPercent > 90;

  return (
    <span
      data-testid="system-resource-segment"
      className="flex w-[150px] shrink-0 items-center justify-end whitespace-nowrap px-1.5 tabular-nums"
      title={t("systemResources")}
    >
      <span>{t("cpuShort")} </span>
      <span style={cpuWarning ? { color: "var(--app-status-warning)" } : undefined}>
        {cpuPercent}%
      </span>
      <span> · {t("memoryShort")} </span>
      <span style={memoryWarning ? { color: "var(--app-status-warning)" } : undefined}>
        {formatGib(stats.memUsed)}/{formatGib(stats.memTotal)}G
      </span>
    </span>
  );
}
