import { lazy, Suspense, useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { ArrowRight } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import HomeHeader from "./HomeHeader";
import HomeQuickActions from "./HomeQuickActions";
import HomeAgentPrompt from "./HomeAgentPrompt";
import HomeActiveSessions from "./HomeActiveSessions";
import HomeGettingStarted from "./HomeGettingStarted";
import HomeRecentProjects from "./HomeRecentProjects";
import HomePinnedWorkspaces from "./HomePinnedWorkspaces";
import type { OpenTerminalOptions } from "@/types";

// 宣传卡只给新用户看，不进入口 chunk。
const HomeDesignHighlights = lazy(() => import("./HomeDesignHighlights"));

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
  const showHistorySkeleton = useDelayedLoading(!historyLoaded);

  // 首页在 home 模式下没有挂载常规 Sidebar，因此主动补齐它通常负责的两份轻量数据。
  const refreshLaunchHistory = useCallback(async () => {
    try {
      const records = await historyService.list(30);
      setLaunchHistory(Array.isArray(records) ? records : []);
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

  const requestedWorkspaces = useRef(workspaces.length > 0);
  useEffect(() => {
    if (requestedWorkspaces.current || workspaces.length > 0 || workspacesLoading) return;
    requestedWorkspaces.current = true;
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
    <div className="app-scrollbar relative flex h-full flex-col overflow-y-auto" data-testid="home-dashboard" style={{ background: "var(--app-bg-deep)" }}>
      {/* 首页是启动器：内容靠上、限宽，打开后眼睛不用找 */}
      <div className="relative flex w-full max-w-[1280px] flex-col mx-auto px-6 pt-6 pb-10 space-y-5">
        {/* 问候区 + 打开工作空间 */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[420px]">
            <HomeHeader version={version} />
          </div>
          <Button onClick={handleEnterWorkspace} className="shrink-0">
            {t("enterWorkspace")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        <HomeQuickActions onNewTerminal={handleNewTerminal} />

        {/* 对 agent 说：首页只发起，对话在工作区的 agent-chat 标签里进行 */}
        <HomeAgentPrompt />

        {/* 活跃会话：真实信息密度，空态优雅降级 */}
        <HomeActiveSessions />

        {isNovice ? (
          <HomeGettingStarted />
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
            {historyLoaded ? (
              <HomeRecentProjects records={launchHistory} onOpenTerminal={onOpenTerminal} />
            ) : showHistorySkeleton ? historySkeleton : null}
            <HomePinnedWorkspaces workspaces={workspaces} onOpenTerminal={onOpenTerminal} />
          </div>
        )}

        {/* 功能介绍只给新用户：老用户每次打开都看宣传卡是干扰。 */}
        {isNovice && showDesignHighlights && (
          <Suspense fallback={null}>
            <HomeDesignHighlights
              compact={false}
              onDismiss={() => setShowDesignHighlights(false)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
