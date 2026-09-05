// RightDock 响应式外壳：宽档（lg/xl）保持现状常驻栏；窄档（<1024px）改为触发式
// Sheet 从右侧滑出，不再挤占主内容区。触发入口复用既有标题栏 PanelRight 按钮
// （titlebar-toggle-right-dock）与模块系统的 module.open("rightDock")，二者都只
// 翻转 useRightDockStore.visible，本壳按档位决定渲染形态。
import { useTranslation } from "react-i18next";
import RightDock from "@/components/rightdock/RightDock";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useMediaUp } from "@/hooks/useBreakpoint";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { OpenTerminalOptions } from "@/types";

interface ResponsiveRightDockProps {
  onOpenTerminal: (options: OpenTerminalOptions) => void;
}

export default function ResponsiveRightDock({ onOpenTerminal }: ResponsiveRightDockProps) {
  const { t } = useTranslation("sidebar");
  const isWide = useMediaUp("lg");
  const visible = useRightDockStore((state) => state.visible);
  const setVisible = useRightDockStore((state) => state.setVisible);
  const width = useRightDockStore((state) => state.width);

  if (isWide) return <RightDock onOpenTerminal={onOpenTerminal} />;

  return (
    <Sheet open={visible} onOpenChange={setVisible}>
      <SheetContent
        side="right"
        className="gap-0 p-0"
        style={{ width, maxWidth: "85vw" }}
      >
        <SheetTitle className="sr-only">{t("rightDock.panelTitle")}</SheetTitle>
        <RightDock onOpenTerminal={onOpenTerminal} overlay />
      </SheetContent>
    </Sheet>
  );
}
