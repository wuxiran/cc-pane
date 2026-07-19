// 应用外壳：五区骨架 TitleBar → ActivityBar | Sidebar | Main → StatusBar。
// 区域用明度分层划分（外框最深、侧栏次深、主区最亮），各区组件自绘背景但
// 统一取对应 --app-* token；分区容器与边框归本壳所有。
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import TitleBar from "@/components/TitleBar";
import ActivityBar from "@/components/ActivityBar";
import StatusBar from "@/components/StatusBar";
import MiniView from "@/components/MiniView";
import BorderlessFloatingButton from "@/components/BorderlessFloatingButton";
import ImportConfirmDialog from "@/components/resources/ImportConfirmDialog";
import OnboardingGuide from "@/components/OnboardingGuide";
import DarkOrbsBackground from "@/components/layout/DarkOrbsBackground";
import MainViewSwitcher from "@/components/layout/MainViewSwitcher";
import AppDialogs from "@/components/layout/AppDialogs";
import { useThemeStore, useMiniModeStore, useWorkspacesStore } from "@/stores";
import type { OpenTerminalOptions } from "@/types";

interface AppShellProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  recentFilesOpen: boolean;
  onCloseRecentFiles: () => void;
}

export default function AppShell({ onOpenTerminal, recentFilesOpen, onCloseRecentFiles }: AppShellProps) {
  const isDark = useThemeStore((s) => s.isDark);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);
  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app h-full flex flex-col relative z-[1]">
        <DarkOrbsBackground />

        {/* Sonner Toast */}
        <Toaster position="top-center" theme={isDark ? "dark" : "light"} richColors />

        {isMiniMode ? (
          <MiniView />
        ) : (
          <>
            <TitleBar
              workspaceName={selectedWorkspace()?.alias || selectedWorkspace()?.name}
            />
            {/* 主区域：ActivityBar | Sidebar/Todo | 主内容区 */}
            <div className="flex-1 flex overflow-hidden relative z-[1]">
              <ActivityBar />
              <MainViewSwitcher onOpenTerminal={onOpenTerminal} />
            </div>
            <StatusBar />
          </>
        )}

        {/* 无边框浮动退出按钮 */}
        <BorderlessFloatingButton />

        {/* 一键导入确认弹窗（deep-link ccpanes://…） */}
        <ImportConfirmDialog />

        {/* Dialog 组件 */}
        <AppDialogs recentFilesOpen={recentFilesOpen} onCloseRecentFiles={onCloseRecentFiles} />

        {/* 新手引导 */}
        <OnboardingGuide />
      </div>
    </TooltipProvider>
  );
}
