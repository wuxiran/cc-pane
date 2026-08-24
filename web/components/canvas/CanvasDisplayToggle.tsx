import { LayoutPanelTop, Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { useCanvasDisplayStore } from "@/stores";

export default function CanvasDisplayToggle() {
  const { t } = useTranslation("orchestration");
  const mode = useCanvasDisplayStore((state) => state.mode);
  const setMode = useCanvasDisplayStore((state) => state.setMode);
  const canvasVisible = mode === "canvas";
  const nextMode = canvasVisible ? "panel" : "canvas";

  return (
    <IconTooltipButton
      label={canvasVisible ? t("hideTerminalCanvas") : t("showTerminalCanvas")}
      aria-pressed={canvasVisible}
      data-testid="canvas-display-toggle"
      onClick={() => setMode(nextMode)}
      className="bg-[var(--app-panel-bg)] shadow-sm"
    >
      {canvasVisible
        ? <LayoutPanelTop className="h-4 w-4" strokeWidth={1.5} />
        : <Network className="h-4 w-4" strokeWidth={1.5} />}
    </IconTooltipButton>
  );
}
