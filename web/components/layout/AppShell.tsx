// 应用外壳：五区骨架 TitleBar → ActivityBar | Sidebar | Main → StatusBar。
// 区域用明度分层划分（外框最深、侧栏次深、主区最亮），各区组件自绘背景但
// 统一取对应 --app-* token；分区容器与边框归本壳所有。
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { TOASTER_OFFSET_MAIN, TOASTER_POSITION } from "@/lib/feedback";
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
import ResponsiveRightDock from "@/components/layout/ResponsiveRightDock";
import OrchestratorAlertBanner from "@/components/OrchestratorAlertBanner";
import RestoreRegressionBanner from "@/components/RestoreRegressionBanner";
import NotificationCenter from "@/components/notifications/NotificationCenter";
import FeatureTips from "@/components/tips/FeatureTips";
import { useThemeStore, useMiniModeStore, useWorkspacesStore } from "@/stores";
import { useFollowActiveTerminalContext } from "@/hooks/useFollowActiveTerminalContext";
import {
  BRAND_MOMENT_TOTAL_MS,
  markBrandMomentPlayed,
  shouldPlayBrandMoment,
} from "@/components/layout/brandMomentOnce";
import type { OpenTerminalOptions } from "@/types";
import "./brandMoment.css";

interface AppShellProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  recentFilesOpen: boolean;
  onCloseRecentFiles: () => void;
}

export default function AppShell({ onOpenTerminal, recentFilesOpen, onCloseRecentFiles }: AppShellProps) {
  const isDark = useThemeStore((s) => s.isDark);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);
  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace);
  useFollowActiveTerminalContext();

  // 冷启动品牌瞬间：仅本应用会话首次挂载播一次（闸门见 brandMomentOnce.ts）。
  // 判定放在 useState 初始化器（StrictMode 双调用结果一致），标记在 effect 里落；
  // 播完撤掉 scope 类，释放 fill-mode 留下的 transform 上下文。
  const [brandMomentActive, setBrandMomentActive] = useState(shouldPlayBrandMoment);
  useEffect(() => {
    if (!brandMomentActive) return;
    markBrandMomentPlayed();
    const timer = setTimeout(() => setBrandMomentActive(false), BRAND_MOMENT_TOTAL_MS);
    return () => clearTimeout(timer);
  }, [brandMomentActive]);
  // mini 模式冷启动不播（标记照常落定，之后切回完整布局也不补播）。
  const brandMoment = brandMomentActive && !isMiniMode;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={`app h-full flex flex-col relative z-[1]${brandMoment ? " brand-moment" : ""}`}
        data-shape-surface="app-shell"
      >
        <DarkOrbsBackground />

        {/* Sonner Toast：bottom-center 避开右下通知中心栈，offset 抬到 StatusBar（28px）上方 */}
        <Toaster
          position={TOASTER_POSITION}
          offset={TOASTER_OFFSET_MAIN}
          theme={isDark ? "dark" : "light"}
          richColors
        />
        <OrchestratorAlertBanner />
        <RestoreRegressionBanner />

        {/* 统一通知中心固定在右下角（update 卡 + 通知栈 + 历史面板），与 bottom-center 的全局 toast 不重叠。 */}
        <NotificationCenter />
        <FeatureTips />

        {isMiniMode ? (
          <MiniView />
        ) : (
          <>
            {/* 五区各裹一层 zone div 挂品牌瞬间落位动画（brandMoment.css）；
                wrapper 复刻原 flex 子项尺寸行为，不改布局与交互。 */}
            <div className="brand-moment-zone brand-moment-zone--titlebar shrink-0">
              <TitleBar
                workspaceName={selectedWorkspace()?.alias || selectedWorkspace()?.name}
              />
            </div>
            {/* 主区域：ActivityBar | Sidebar/Todo | 主内容区 */}
            <div className="min-w-0 flex-1 flex overflow-hidden relative z-[1]">
              <div className="brand-moment-zone brand-moment-zone--activitybar h-full shrink-0">
                <ActivityBar />
              </div>
              <div className="brand-moment-zone brand-moment-zone--content min-h-0 min-w-0 flex-1 flex">
                <MainViewSwitcher onOpenTerminal={onOpenTerminal} />
              </div>
              <div className="brand-moment-zone brand-moment-zone--rightdock h-full shrink-0">
                <ResponsiveRightDock onOpenTerminal={onOpenTerminal} />
              </div>
            </div>
            <div className="brand-moment-zone brand-moment-zone--statusbar shrink-0">
              <StatusBar />
            </div>
          </>
        )}

        {/* 无边框浮动退出按钮 */}
        <BorderlessFloatingButton />

        {/* 一键导入确认弹窗（deep-link ccpanes://…） */}
        <ImportConfirmDialog />

        {/* Dialog 组件 */}
        <AppDialogs recentFilesOpen={recentFilesOpen} onCloseRecentFiles={onCloseRecentFiles} />

        {/* 新手引导 */}
        <OnboardingGuide onOpenTerminal={onOpenTerminal} />
      </div>
    </TooltipProvider>
  );
}
