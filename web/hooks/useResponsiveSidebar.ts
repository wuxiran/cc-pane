// 侧栏响应式接线：宽档（lg/xl）保持现状常驻；窄档（<1024px）侧栏改为浮出层。
// 跨档时迁移显隐偏好，两个档位的偏好互不覆盖：
// - 进入窄档：记住宽档偏好，应用窄档偏好（默认收起）；
// - 窄档内的展开/收起即时写入 localStorage（SIDEBAR_FLYOUT_STORAGE_KEY）；
// - 回到宽档：恢复进入窄档前记住的宽档偏好。
// 侧栏显隐本身仍复用 useActivityBarStore.sidebarVisible，ActivityBar 图标、
// 标题栏折叠按钮、orchestration 等既有交互在窄档下自动变为「开/关浮出层」。
import { useEffect, useRef } from "react";
import { useMediaUp } from "@/hooks/useBreakpoint";
import { loadSidebarFlyoutOpen, saveSidebarFlyoutOpen } from "@/lib/sidebarFlyout";
import { useActivityBarStore } from "@/stores/useActivityBarStore";

export function useResponsiveSidebar() {
  // 与 Tailwind lg: 前缀同义：达到 1024px 即宽档常驻侧栏。
  const isWide = useMediaUp("lg");
  const isFlyout = !isWide;
  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const setSidebarVisible = useActivityBarStore((s) => s.setSidebarVisible);
  // null 表示「当前不在窄档停留过，无需恢复」
  const widePrefRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (isFlyout) {
      // 只在刚进入窄档时迁移一次（widePrefRef 为空说明上一轮不在窄档）
      if (widePrefRef.current === null) {
        widePrefRef.current = useActivityBarStore.getState().sidebarVisible;
        const flyoutOpen = loadSidebarFlyoutOpen();
        if (useActivityBarStore.getState().sidebarVisible !== flyoutOpen) {
          setSidebarVisible(flyoutOpen);
        }
      }
    } else if (widePrefRef.current !== null) {
      const restore = widePrefRef.current;
      widePrefRef.current = null;
      if (useActivityBarStore.getState().sidebarVisible !== restore) {
        setSidebarVisible(restore);
      }
    }
  }, [isFlyout, setSidebarVisible]);

  // 窄档内的显隐变化即浮出层偏好（含 ActivityBar/标题栏等既有入口的切换）
  useEffect(() => {
    if (isFlyout) saveSidebarFlyoutOpen(sidebarVisible);
  }, [isFlyout, sidebarVisible]);

  return { isFlyout };
}
