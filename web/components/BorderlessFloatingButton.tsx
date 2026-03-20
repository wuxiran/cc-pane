import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBorderlessStore } from "@/stores";

export default function BorderlessFloatingButton() {
  const { t } = useTranslation("common");
  const isBorderless = useBorderlessStore((s) => s.isBorderless);
  const exitBorderless = useBorderlessStore((s) => s.exitBorderless);

  if (!isBorderless) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => exitBorderless()}
          className="fixed bottom-4 right-4 z-[9998] w-8 h-8 flex items-center justify-center rounded-full opacity-30 hover:opacity-100 transition-all duration-200 backdrop-blur-sm"
          style={{
            background: "var(--app-overlay)",
            border: "1px solid var(--app-border)",
            color: "var(--app-text-secondary)",
          }}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        <p>{t("exitBorderless")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
