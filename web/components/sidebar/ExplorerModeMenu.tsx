// 侧栏标题下拉（Codex 式「标题 ▾」）：切换简洁 / 完整两种资源管理器模式。
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useExplorerSectionsStore, type ExplorerMode } from "@/stores";

const MODES: readonly ExplorerMode[] = ["simple", "full"];

export default function ExplorerModeMenu() {
  const { t } = useTranslation("sidebar");
  const mode = useExplorerSectionsStore((s) => s.explorerMode);
  const setMode = useExplorerSectionsStore((s) => s.setExplorerMode);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("explorer.mode")}
          data-testid="explorer-mode-trigger"
          className="-ml-1.5 flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[length:var(--text-caption)] font-semibold text-[var(--app-text-tertiary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-secondary)] data-[state=open]:bg-[var(--app-hover)] data-[state=open]:text-[var(--app-text-secondary)]"
        >
          {t("explorer.title")}
          <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        <DropdownMenuRadioGroup value={mode} onValueChange={(value) => setMode(value as ExplorerMode)}>
          {MODES.map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              {t(item === "simple" ? "explorer.modeSimple" : "explorer.modeFull")}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
