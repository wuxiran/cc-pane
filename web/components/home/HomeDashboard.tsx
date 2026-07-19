import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { ArrowRight } from "lucide-react";
import { historyService } from "@/services";
import type { LaunchRecord } from "@/services";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { waitForTauri } from "@/utils";
import { isTauriRuntime } from "@/services/runtime";
import HomeHeader from "./HomeHeader";
import HomeQuickActions from "./HomeQuickActions";
import HomeRecentProjects from "./HomeRecentProjects";
import HomeActiveSessions from "./HomeActiveSessions";
import HomeEnvironment from "./HomeEnvironment";
import HomeUsageStats from "./HomeUsageStats";
import HomeShortcuts from "./HomeShortcuts";
import HomeGettingStarted from "./HomeGettingStarted";
import HomeDesignHighlights from "./HomeDesignHighlights";
import type { OpenTerminalOptions } from "@/types";

interface HomeDashboardProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function HomeDashboard({ onOpenTerminal }: HomeDashboardProps) {
  const { t } = useTranslation("home");
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const setSidebarVisible = useActivityBarStore((s) => s.setSidebarVisible);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);

  const [version, setVersion] = useState("...");
  const [records, setRecords] = useState<LaunchRecord[]>([]);

  // 新用户判定：没有任何工作空间，或所有工作空间都没有项目
  const isNewUser =
    workspaces.length === 0
    || workspaces.every((ws) => (Array.isArray(ws.projects) ? ws.projects.length : 0) === 0);

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
    if (!isTauriRuntime()) {
      setVersion(packageJson.version);
      void loadRecords();
      void loadWorkspaces().catch(() => undefined);
      return () => { cancelled = true; };
    }
    waitForTauri().then(async (ready) => {
      if (cancelled || !ready) return;
      try {
        const v = await getVersion();
        if (!cancelled) setVersion(v);
      } catch {
        // fallback
      }
      await loadRecords();
      // 新用户判定依赖工作空间列表（引导卡场景下 HomeUsageStats 不渲染，需自行加载）
      await loadWorkspaces().catch(() => undefined);
    });
    return () => { cancelled = true; };
  }, [loadRecords, loadWorkspaces]);

  // 监听 history-updated 事件刷新
  useEffect(() => {
    const handler = () => { loadRecords(); };
    window.addEventListener("cc-panes:history-updated", handler);
    return () => window.removeEventListener("cc-panes:history-updated", handler);
  }, [loadRecords]);

  const handleNewTerminal = useCallback(() => {
    useDialogStore.getState().openLauncher();
  }, []);

  // 进入分屏视图时一并展开左侧面板，避免落地在一个空荡荡的界面
  const handleEnterWorkspace = useCallback(() => {
    setAppViewMode("panes");
    setSidebarVisible(true);
  }, [setAppViewMode, setSidebarVisible]);

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

      <div className="relative w-full px-6 2xl:px-10 pt-8 pb-12 space-y-6">
        {/* 问候区 + 首页主 CTA：窄屏换行整行铺开，宽屏与问候语同排右对齐 */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[420px]">
            <HomeHeader version={version} />
          </div>
          <button
            className="inline-flex w-full sm:w-auto shrink-0 items-center justify-center gap-2.5 px-10 py-4 rounded-2xl text-base font-semibold cursor-pointer transition-all duration-[var(--dur-fast)] hover:-translate-y-[1px] hover:shadow-xl active:translate-y-0"
            style={{
              background: "linear-gradient(135deg, var(--app-accent), color-mix(in srgb, var(--app-accent) 60%, black))",
              color: "var(--primary-foreground)",
              boxShadow: "0 6px 20px color-mix(in srgb, var(--app-accent) 35%, transparent)",
            }}
            onClick={handleEnterWorkspace}
          >
            {t("enterWorkspace")}
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
        <HomeQuickActions onNewTerminal={handleNewTerminal} />

        {/* 宽屏（≥1600px 视口）两列：左列 引导卡/用量趋势，右列 环境+最近项目+活跃会话；窄屏单列（现状顺序） */}
        <div className="grid grid-cols-1 min-[1600px]:grid-cols-[minmax(0,1.6fr)_minmax(340px,1fr)] gap-6 items-stretch">
          {/* 左列：用量趋势弹性拉伸 + 快捷键速查，与右列底边对齐 */}
          <div className="min-w-0 flex flex-col gap-6">
            {isNewUser ? (
              <>
                <HomeGettingStarted onNewTerminal={handleNewTerminal} />
                <HomeDesignHighlights />
              </>
            ) : (
              <HomeUsageStats />
            )}
            <HomeShortcuts />
          </div>
          <div className="min-w-0 space-y-6">
            <HomeEnvironment />
            <HomeRecentProjects records={records} onOpenTerminal={onOpenTerminal} />
            <HomeActiveSessions />
          </div>
        </div>

        {/* 老用户：设计理念收敛为页脚紧凑横条 */}
        {!isNewUser && <HomeDesignHighlights compact />}
      </div>
    </div>
  );
}
