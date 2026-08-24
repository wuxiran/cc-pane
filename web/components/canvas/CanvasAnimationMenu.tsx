import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCanvasDisplayStore, type CanvasAnimationIntensity } from "@/stores";

const INTENSITIES: CanvasAnimationIntensity[] = ["full", "reduced", "off"];

export default function CanvasAnimationMenu() {
  const { t } = useTranslation("orchestration");
  const intensity = useCanvasDisplayStore((state) => state.animationIntensity);
  const setIntensity = useCanvasDisplayStore((state) => state.setAnimationIntensity);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("canvasAnimationSettings")}
          title={t("canvasAnimationSettings")}
          data-testid="canvas-animation-menu"
          className="inline-flex items-center justify-center rounded-md bg-[var(--app-panel-bg)] p-1 text-[var(--app-text-secondary)] shadow-sm transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
        >
          <Gauge className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuLabel>{t("canvasAnimationSettings")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={intensity}
          onValueChange={(value) => {
            if (INTENSITIES.includes(value as CanvasAnimationIntensity)) {
              setIntensity(value as CanvasAnimationIntensity);
            }
          }}
        >
          <DropdownMenuRadioItem value="full">{t("canvasAnimationFull")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="reduced">{t("canvasAnimationReduced")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off">{t("canvasAnimationOff")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
