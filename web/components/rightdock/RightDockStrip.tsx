import type { LucideIcon } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import type { RightDockView } from "@/stores/useRightDockStore";

export interface RightDockStripItem {
  id: RightDockView;
  icon: LucideIcon;
  label: string;
}

interface RightDockStripProps {
  activeView: RightDockView;
  visible: boolean;
  items: readonly RightDockStripItem[];
  onToggleView: (view: RightDockView) => void;
}

export default function RightDockStrip({
  activeView,
  visible,
  items,
  onToggleView,
}: RightDockStripProps) {
  return (
    <div
      className="flex h-full w-14 shrink-0 select-none flex-col items-center gap-1.5 py-2"
      style={{
        background: "var(--app-activity-bar-bg)",
        borderLeft: "1px solid var(--app-activity-border)",
        backdropFilter: "blur(var(--app-glass-blur))",
        WebkitBackdropFilter: "blur(var(--app-glass-blur))",
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      {items.map(({ id, icon: Icon, label }) => {
        const active = visible && activeView === id;
        return (
          <div key={id} className="relative flex w-full justify-center">
            {active && (
              <span
                aria-hidden
                className="absolute right-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-l-md bg-[var(--app-accent)]"
              />
            )}
            <IconTooltipButton
              label={label}
              side="left"
              aria-pressed={active}
              onClick={() => onToggleView(id)}
              className={`h-10 w-10 rounded-xl ${
                active
                  ? "bg-[var(--app-activity-item-active)] text-[var(--app-accent)] shadow-[var(--app-activity-item-active-shadow)]"
                  : "text-[var(--app-icon-inactive)] hover:bg-[var(--app-activity-item-hover)] hover:text-[var(--app-icon-hover)]"
              }`}
            >
              <Icon className="h-[22px] w-[22px]" strokeWidth={1.5} />
            </IconTooltipButton>
          </div>
        );
      })}
    </div>
  );
}
