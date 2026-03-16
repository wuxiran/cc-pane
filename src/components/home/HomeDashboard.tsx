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
import HomeShortcuts from "./HomeShortcuts";
import type { CliTool } from "@/types";

interface HomeDashboardProps {
  onOpenTerminal: (
    path: string,
    workspaceName?: string,
    providerId?: string,
    workspacePath?: string,
    cliTool?: CliTool,
    resumeId?: string,
  ) => void;
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
    <div className="h-full overflow-y-auto relative">
      {/* 背景装饰 — 暗色模式渐变光球 */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden opacity-30 dark:opacity-20"
        aria-hidden="true"
      >
        <div
          className="absolute -top-32 -right-32 w-96 h-96 rounded-full blur-[120px]"
          style={{ background: "var(--app-orb-1, transparent)" }}
        />
        <div
          className="absolute top-1/3 -left-24 w-72 h-72 rounded-full blur-[100px]"
          style={{ background: "var(--app-orb-2, transparent)" }}
        />
      </div>

      <div className="relative max-w-4xl mx-auto px-6 pt-8 pb-12 space-y-6">
        <HomeHeader version={version} />
        <HomeQuickActions onNewTerminal={handleNewTerminal} />
        <HomeRecentProjects records={records} onOpenTerminal={onOpenTerminal} />

        <div className="grid grid-cols-2 gap-4">
          <HomeActiveSessions />
          <HomeEnvironment />
        </div>

        <HomeShortcuts />

        {/* 进入工作区按钮 */}
        <div className="flex justify-center pt-2 pb-2">
          <button
            className="inline-flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-semibold cursor-pointer transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg active:translate-y-0"
            style={{
              background: "var(--app-accent)",
              color: "white",
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
