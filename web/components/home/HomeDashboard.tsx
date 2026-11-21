import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../../package.json";
import { ArrowRight, Settings, SquareTerminal } from "lucide-react";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore, useWorkspacesStore } from "@/stores";
import { historyService, type LaunchRecord } from "@/services";
import { waitForTauri } from "@/utils";
import { isTauriRuntime } from "@/services/runtime";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useCliTools } from "@/hooks/useCliTools";
import HomeHeader from "./HomeHeader";
import HomeAgentPrompt from "./HomeAgentPrompt";
import HomeQuickStart from "./HomeQuickStart";
import HomeAgentList from "./HomeAgentList";
import HomeWorkbench from "./HomeWorkbench";
import HomeAgentInstall from "./HomeAgentInstall";
import HomeRecentProjects from "./HomeRecentProjects";
import HomeSetupDialogs from "./HomeSetupDialogs";
import type { OpenTerminalOptions } from "@/types";

interface HomeDashboardProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function HomeDashboard({ onOpenTerminal }: HomeDashboardProps) {
  const { t } = useTranslation("home");
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
  const setSidebarVisible = useActivityBarStore((s) => s.setSidebarVisible);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspacesLoading = useWorkspacesStore((s) => s.loading);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const { tools: cliTools, installedTools, loading: cliToolsLoading, refresh: refreshCliTools } = useCliTools();
  const [cliToolsReady, setCliToolsReady] = useState(false);
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
    if (!cliToolsLoading) setCliToolsReady(true);
  }, [cliToolsLoading]);

  // 用户去终端装完 CLI 回到窗口时重新检测，新装的自动从「安装其他 Agent」移到 Agent 列表。
  useEffect(() => {
    const handleFocus = () => void refreshCliTools();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshCliTools]);

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

  const historySkeleton = (
    <div className="space-y-2 p-2" data-testid="home-recent-projects-skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((item) => (
        <Skeleton key={item} className="h-6 w-full" />
      ))}
    </div>
  );

  return (
    <div className="app-scrollbar relative flex h-full flex-col overflow-y-auto" data-testid="home-dashboard" style={{ background: "var(--app-bg-deep)" }}>
      {/* 首页是启动器（参考 magpie 的分段节奏）：一段一张大卡、卡内一行一项，限宽靠上。
          宽屏时「继续工作」挂到右侧栏（吸顶），窄屏落到主栏下方。 */}
      <div className="relative mx-auto flex w-full max-w-[1460px] gap-8 px-6 pb-12 pt-6 max-xl:flex-col">
        <div className="flex min-w-0 max-w-[1100px] flex-1 flex-col space-y-8">
          <HomeHeader
            version={version}
            actions={
              <>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleNewTerminal} data-testid="home-new-terminal">
                  <SquareTerminal aria-hidden="true" />
                  {t("newTerminal")}
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => useDialogStore.getState().openSettings()}>
                  <Settings aria-hidden="true" />
                  {t("settings")}
                </Button>
                <Button size="sm" onClick={handleEnterWorkspace}>
                  {t("enterWorkspace")}
                  <ArrowRight aria-hidden="true" />
                </Button>
              </>
            }
          />

          {/* 对 agent 说：首页只发起，对话在工作区的 agent-chat 标签里进行 */}
          <HomeAgentPrompt />

          <HomeQuickStart installedTools={installedTools} />

          <HomeAgentList
            tools={cliTools}
            installedTools={installedTools}
            loading={cliToolsLoading}
            onRefresh={() => void refreshCliTools()}
          onOpenTerminal={onOpenTerminal}
          />

          <HomeAgentInstall installedTools={installedTools} ready={cliToolsReady} onOpenTerminal={onOpenTerminal} />
          <HomeSetupDialogs />
        </div>

        <aside className="w-full shrink-0 xl:sticky xl:top-6 xl:max-h-[calc(100vh-5rem)] xl:w-80 xl:self-start xl:overflow-y-auto app-scrollbar">
          <HomeWorkbench
            workspaces={workspaces}
            onOpenTerminal={onOpenTerminal}
            recent={
              historyLoaded ? (
                <HomeRecentProjects records={launchHistory} onOpenTerminal={onOpenTerminal} />
              ) : showHistorySkeleton ? historySkeleton : null
            }
          />
        </aside>
      </div>
    </div>
  );
}
