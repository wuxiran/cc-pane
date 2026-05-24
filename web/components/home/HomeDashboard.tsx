import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowRight } from "lucide-react";
import { historyService } from "@/services";
import type { LaunchRecord } from "@/services";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { waitForTauri } from "@/utils";
import HomeHeader from "./HomeHeader";
import HomeQuickActions from "./HomeQuickActions";
import HomeRecentProjects from "./HomeRecentProjects";
import HomeActiveSessions from "./HomeActiveSessions";
import HomeEnvironment from "./HomeEnvironment";
import HomeUsageStats from "./HomeUsageStats";
import HomeShortcuts from "./HomeShortcuts";
import type { OpenTerminalOptions } from "@/types";

interface HomeDashboardProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function HomeDashboard({ onOpenTerminal }: HomeDashboardProps) {
  const { t } = useTranslation("home");
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);

  const [version, setVersion] = useState("...");
  const [records, setRecords] = useState<LaunchRecord[]>([]);

  const loadRecords = useCallback(async () => {
    try {
      const list = await historyService.list(20);
      setRecords(list);
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    waitForTauri().then(async (ready) => {
      if (cancelled || !ready) return;
      try {
        const v = await getVersion();
        if (!cancelled) setVersion(v);
      } catch {
        // fallback
      }
      await loadRecords();
    });
    return () => { cancelled = true; };
  }, [loadRecords]);

  // 监听 history-updated 事件刷新
  useEffect(() => {
    const handler = () => { loadRecords(); };
    window.addEventListener("cc-panes:history-updated", handler);
    return () => window.removeEventListener("cc-panes:history-updated", handler);
  }, [loadRecords]);

  const handleNewTerminal = useCallback(() => {
    setAppViewMode("panes");
  }, [setAppViewMode]);

  return (
    <div
      className="h-full overflow-y-auto relative"
      style={{ background: "var(--app-bg-deep)" }}
    >
      {/* 背景装饰 — 暗色模式渐变光球 */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden opacity-30 dark:opacity-20"
        aria-hidden="true"
      >
        <div
          className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] rounded-full"
          style={{
            background: "var(--app-orb-1, transparent)",
            filter: "blur(var(--app-orb-blur-lg, 120px))",
          }}
        />
        <div
          className="absolute top-[30%] right-[-10%] w-[400px] h-[400px] rounded-full"
          style={{
            background: "var(--app-orb-2, transparent)",
            filter: "blur(var(--app-orb-blur-md, 100px))",
          }}
        />
      </div>

      <div className="relative w-full max-w-[1480px] mx-auto px-6 2xl:px-8 pt-8 pb-12 space-y-6">
        <HomeHeader version={version} />
        <HomeQuickActions onNewTerminal={handleNewTerminal} />

        {/* 第二行：统计（左大） + 开发环境（右小） — 首屏可见 */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.5fr)] gap-4 items-start">
          <HomeUsageStats />
          <HomeEnvironment />
        </div>

        <HomeRecentProjects records={records} onOpenTerminal={onOpenTerminal} />

        <HomeActiveSessions />

        <HomeShortcuts />

        {/* 进入工作区按钮 */}
        <div className="flex justify-center pt-2 pb-2">
          <button
            className="inline-flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-semibold cursor-pointer transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg active:translate-y-0"
            style={{
              background: "linear-gradient(135deg, var(--app-accent), color-mix(in srgb, var(--app-accent) 60%, black))",
              color: "var(--primary-foreground)",
              boxShadow: "0 4px 14px color-mix(in srgb, var(--app-accent) 35%, transparent)",
            }}
            onClick={() => setAppViewMode("panes")}
          >
            {t("enterWorkspace")}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
