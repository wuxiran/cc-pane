// 固定布局（Chrome 固定标签式）：只显示名称首字 + 最紧急状态点，常驻布局条一端。
// 右键可取消固定、把固定区挪到另一端；悬停提示完整名称。
import { ArrowLeftToLine, ArrowRightToLine, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TERMINAL_STATUS_PRESENTATION } from "@/lib/statusPresentation";
import type { LayoutBarDensity, PinnedLayoutSide } from "@/stores";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import { deriveLayoutStatusSummary, mostUrgentLayoutStatus } from "./layoutStatusSummary";

export default function PinnedLayoutTab({
  layout,
  tree,
  selected,
  density,
  statusMap,
  side,
  onSelect,
  onUnpin,
  onMoveSide,
}: {
  layout: LayoutEntry;
  tree: PaneNode;
  selected: boolean;
  density: LayoutBarDensity;
  statusMap: Map<string, TerminalStatusInfo>;
  side: PinnedLayoutSide;
  onSelect: () => void;
  onUnpin: () => void;
  onMoveSide: (side: PinnedLayoutSide) => void;
}) {
  const { t } = useTranslation("panes");
  const urgent = mostUrgentLayoutStatus(deriveLayoutStatusSummary(tree, statusMap));
  const initial = Array.from(layout.name.trim())[0] ?? "·";
  const size = density === "comfortable" ? 40 : 28;
  const otherSide: PinnedLayoutSide = side === "left" ? "right" : "left";
  const MoveIcon = otherSide === "right" ? ArrowRightToLine : ArrowLeftToLine;

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={layout.name}
              data-layout-id={layout.id}
              data-pinned="true"
              onClick={onSelect}
              className="relative flex flex-shrink-0 items-center justify-center rounded-md border text-[length:var(--text-row)] font-semibold transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
              style={{
                width: size,
                height: size,
                ...(selected
                  ? {
                      background: "color-mix(in srgb, var(--app-text-primary) 11%, transparent)",
                      borderColor: "var(--app-border)",
                      color: "var(--app-text-primary)",
                    }
                  : { borderColor: "transparent", color: "var(--app-text-secondary)" }),
              }}
            >
              {initial}
              {urgent ? (
                <span
                  aria-hidden="true"
                  data-pinned-status={urgent.bucket}
                  className="absolute right-1 top-1 size-1.5 rounded-full"
                  style={{ background: TERMINAL_STATUS_PRESENTATION[urgent.status].colorToken }}
                />
              ) : null}
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent>{layout.name}</TooltipContent>
      </Tooltip>
      <ContextMenuContent className="z-[160] w-48">
        <ContextMenuItem onSelect={onUnpin}>
          <PinOff />
          {t("unpinLayout")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onMoveSide(otherSide)}>
          <MoveIcon />
          {t(otherSide === "right" ? "pinnedLayoutsToRight" : "pinnedLayoutsToLeft")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
