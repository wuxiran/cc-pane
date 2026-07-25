import { ChevronDown, PanelTopOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import AiPanelFrame from "@/components/aipanel/AiPanelFrame";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAiPanelStore } from "@/stores/useAiPanelStore";

function formatUpdatedAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function AiPanelView() {
  const { t, i18n } = useTranslation("sidebar");
  const panels = useAiPanelStore((state) => state.panels);
  const activePanelId = useAiPanelStore((state) => state.activePanelId);
  const activePanel = panels.find((panel) => panel.panelId === activePanelId) ?? panels[0];
  const selectPanel = useAiPanelStore((state) => state.selectPanel);

  if (!activePanel) {
    return (
      <EmptyState
        icon={PanelTopOpen}
        title={t("aiPanel.empty")}
        className="h-full"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--app-panel-bg)]">
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--app-text-primary)]">
            {activePanel.title}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-[var(--app-text-tertiary)]">
            <span className="truncate">
              {t("aiPanel.drivenBy", { name: activePanel.driverName })}
            </span>
            <span aria-hidden="true">/</span>
            <span className="shrink-0">
              {t("aiPanel.updatedAt", {
                time: formatUpdatedAt(activePanel.updatedAt, i18n.language),
              })}
            </span>
          </div>
        </div>

        {panels.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("aiPanel.switchPanel")}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--app-text-secondary)] outline-none hover:bg-[var(--app-hover)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              >
                <ChevronDown aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuRadioGroup value={activePanel.panelId} onValueChange={selectPanel}>
                {panels.map((panel) => (
                  <DropdownMenuRadioItem key={panel.panelId} value={panel.panelId}>
                    <span className="truncate">{panel.title}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AiPanelFrame panel={activePanel} />
      </div>
    </div>
  );
}
