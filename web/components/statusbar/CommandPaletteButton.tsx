// 命令面板的非快捷键入口（docs/68 §3.1 方案 B）：Ctrl+K 在终端聚焦时被放行给终端，
// 而命令面板是其余被放行动作唯一的替代路径——这个按钮保证它随时可达。
import { Command } from "lucide-react";
import { useTranslation } from "react-i18next";
import { COMMAND_PALETTE_TOGGLE_EVENT } from "@/components/CommandPalette";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatKeyCombo, useSettingsStore } from "@/stores";

export default function CommandPaletteButton() {
  const { t } = useTranslation("shortcuts");
  const binding = useSettingsStore((s) => s.settings?.shortcuts.bindings["command-palette"] ?? "");
  const combo = binding ? formatKeyCombo(binding) : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="flex items-center px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--app-hover)]"
          aria-label={t("command-palette")}
          onClick={() => window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT))}
        >
          <Command className="w-3 h-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{combo ? `${t("command-palette")} · ${combo}` : t("command-palette")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
