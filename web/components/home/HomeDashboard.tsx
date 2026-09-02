import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { ArrowRight, Eye } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  useDialogStore,
  useHomePreferencesStore,
  useSettingsStore,
  useWorkspacesStore,
} from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import { waitForTauri } from "@/utils";
import { isTauriRuntime } from "@/services/runtime";
import { Skeleton } from "@/components/ui/skeleton";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import HomeHeader from "./HomeHeader";
import HomeQuickActions from "./HomeQuickActions";
import HomeActiveSessions from "./HomeActiveSessions";
import HomeDesignHighlights from "./HomeDesignHighlights";
import HomeGettingStarted from "./HomeGettingStarted";
import HomeRecentProjects from "./HomeRecentProjects";
import HomePinnedWorkspaces from "./HomePinnedWorkspaces";
import type { OpenTerminalOptions } from "@/types";

interface HomeDashboardProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function HomeDashboard({ onOpenTerminal }: HomeDashboardProps) {
  const { t } = useTranslation("home");
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const setSidebarVisible = useActivityBarStore((s) => s.setSidebarVisible);
  const settings = useSettingsStore((s) => s.settings);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspacesLoading = useWorkspacesStore((s) => s.loading);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const showDesignHighlights = useHomePreferencesStore((s) => s.showDesignHighlights);
  const setShowDesignHighlights = useHomePreferencesStore((s) => s.setShowDesignHighlights);
  const [version, setVersion] = useState("...");
  const [launchHistory, setLaunchHistory] = useState<LaunchRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // 首页在 home 模式下没有挂载常规 Sidebar，因此主动补齐它通常负责的两份轻量数据。
  const refreshLaunchHistory = useCallback(async () => {
    try {
      setLaunchHistory(await historyService.list(30));
    } catch {
      setLaunchHistory([]);
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshLaunchHistory();
    const handler = () => void refreshLaunchHistory();
    window.addEventListener("cc-panes:history-updated", handler);
    return () => window.removeEventListener("cc-panes:history-updated", handler);
  }, [refreshLaunchHistory]);

  useEffect(() => {
    if (workspaces.length > 0 || workspacesLoading) return;
    void loadWorkspaces().catch(() => undefined);
  }, [loadWorkspaces, workspaces.length, workspacesLoading]);

  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      setVersion(packageJson.version);
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
    });
    return () => { cancelled = true; };
  }, []);

  const handleNewTerminal = useCallback(() => {
    useDialogStore.getState().openLauncher();
  }, []);

  // 进入分屏视图时一并展开左侧面板，避免落地在一个空荡荡的界面
  const handleEnterWorkspace = useCallback(() => {
    setAppViewMode("panes");
    setSidebarVisible(true);
  }, [setAppViewMode, setSidebarVisible]);

  // Settings is loaded before the shell is released. Treat an unavailable value as
  // the established dashboard so a transient settings fetch cannot flash onboarding.
  const isNovice = settings?.general?.onboardingCompleted === false;

  const historySkeleton = (
    <div className="min-w-0" data-testid="home-recent-projects-skeleton" aria-hidden="true">
      <div className="mb-3 h-4 w-28 rounded bg-[var(--app-hover)] animate-pulse" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="flex h-16 items-center gap-3 rounded-xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] p-3">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-2.5 w-2/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    // 竖向配重：滚动容器挂 flex 列 + 内容块 my-auto——大屏内容不足一屏时垂直居中呼吸，
    // 内容超出视口时 auto margin 归零，从顶部正常滚动，小窗口行为不变。
    <div className="app-scrollbar relative flex h-full flex-col overflow-y-auto" data-testid="home-dashboard" style={{ background: "var(--app-bg-deep)" }}>
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

      {/* 大屏限宽居中 + 间距/留白随断点升级，避免 2K 下内容细长拉伸、头重脚轻 */}
      <div className="relative flex w-full max-w-[1500px] flex-col mx-auto my-auto px-6 lg:px-8 2xl:px-10 pt-8 lg:pt-10 2xl:pt-12 pb-12 lg:pb-14 2xl:pb-16 space-y-6 lg:space-y-8 2xl:space-y-10">
        {/* 问候区 + 首页主 CTA：窄屏换行整行铺开，宽屏与问候语同排右对齐 */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[420px]">
            <HomeHeader version={version} />
          </div>
          <button
            className="inline-flex w-full sm:w-auto shrink-0 items-center justify-center gap-2.5 px-10 py-4 xl:px-12 xl:py-5 rounded-2xl text-base xl:text-lg font-semibold cursor-pointer transition-all duration-[var(--dur-fast)] hover:-translate-y-[1px] hover:shadow-xl active:translate-y-0"
            style={{
              background: "linear-gradient(135deg, var(--app-accent), color-mix(in srgb, var(--app-accent) 60%, black))",
              color: "var(--primary-foreground)",
              boxShadow: "0 6px 20px color-mix(in srgb, var(--app-accent) 35%, transparent)",
            }}
            onClick={handleEnterWorkspace}
          >
            {t("enterWorkspace")}
            <ArrowRight className="w-5 h-5 xl:w-6 xl:h-6" />
          </button>
          {!showDesignHighlights && (
            <IconTooltipButton
              label={t("showHighlights")}
              data-testid="show-design-highlights"
              onClick={() => setShowDesignHighlights(true)}
              className="size-8 shrink-0 text-[var(--app-text-tertiary)]"
            >
              <Eye aria-hidden="true" className="size-4" />
            </IconTooltipButton>
          )}
        </div>
        <HomeQuickActions onNewTerminal={handleNewTerminal} onOpenTerminal={onOpenTerminal} />

        {/* 活跃会话：真实信息密度，空态优雅降级 */}
        <HomeActiveSessions />

        {isNovice ? (
          <HomeGettingStarted />
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
            {historyLoaded ? (
              <HomeRecentProjects records={launchHistory} onOpenTerminal={onOpenTerminal} />
            ) : historySkeleton}
            <HomePinnedWorkspaces workspaces={workspaces} onOpenTerminal={onOpenTerminal} />
          </div>
        )}

        {showDesignHighlights && (
          <HomeDesignHighlights
            compact={!isNovice}
            onDismiss={() => setShowDesignHighlights(false)}
          />
        )}
      </div>
    </div>
  );
}
