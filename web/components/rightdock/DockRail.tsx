// 右侧面板最右边的竖向视图栏（与左侧活动栏对称）：点一下切视图，悬停显示名字。
import type { LucideIcon } from "lucide-react";
import { PanelRightClose } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type DockRailBadgeTone = "blue" | "amber" | "red";

export interface DockRailItem {
  id: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  badge?: DockRailBadgeTone;
}

const BADGE_COLOR: Record<DockRailBadgeTone, string> = {
  blue: "var(--app-accent)",
  amber: "var(--app-status-warning)",
  red: "var(--app-status-danger)",
};

interface DockRailProps {
  items: readonly DockRailItem[];
  activeId: string;
  collapseLabel: string;
  onCollapse: () => void;
}

export default function DockRail({ items, activeId, collapseLabel, onCollapse }: DockRailProps) {
  return (
    <nav
      data-testid="right-dock-rail"
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-l py-1.5"
      style={{ borderColor: "var(--app-border)" }}
    >
      <div className="flex flex-col items-center gap-1" role="tablist" aria-orientation="vertical" aria-label={items.map((item) => item.label).join(" / ")}>
        {items.map(({ id, icon: Icon, label, onSelect, badge }) => {
          const selected = id === activeId;
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  data-rail-id={id}
                  aria-selected={selected}
                  aria-label={label}
                  onClick={onSelect}
                  className={`relative flex size-8 items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] ${
                    selected
                      ? "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]"
                      : "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)]"
                  }`}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.6} />
                  {badge && (
                    <span
                      data-testid={`right-dock-rail-badge-${id}`}
                      aria-hidden="true"
                      className="absolute right-1 top-1 size-1.5 rounded-full"
                      style={{ background: BADGE_COLOR[badge] }}
                    />
                  )}
                  {selected && (
                    <span aria-hidden className="absolute -right-[5px] inset-y-2 w-[2px] rounded-full" style={{ background: "var(--app-text-primary)" }} />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <span className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={collapseLabel}
            onClick={onCollapse}
            className="flex size-8 items-center justify-center rounded-md text-[var(--app-text-tertiary)] transition-colors hover:text-[var(--app-text-primary)]"
          >
            <PanelRightClose className="size-4" strokeWidth={1.6} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{collapseLabel}</TooltipContent>
      </Tooltip>
    </nav>
  );
}
