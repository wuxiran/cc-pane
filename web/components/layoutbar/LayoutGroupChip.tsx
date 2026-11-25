// 布局条的工作空间分组头（Chrome 标签组式）。
// 展开态：一枚带工作空间颜色的小标签，点一下把整组收起。
// 折叠态：一叠错开的卡片（组名 + 数量 + 组内最紧急状态），点开弹出组内布局列表，
// 可直接切换或展开分组。右键两种状态都能折叠 / 展开。
import { useState, type ReactElement } from "react";
import { ChevronsLeftRight, FoldHorizontal, UnfoldHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TERMINAL_STATUS_PRESENTATION } from "@/lib/statusPresentation";
import type { LayoutBarDensity } from "@/stores";
import type { PaneNode, TerminalStatusInfo } from "@/types";
import { deriveLayoutStatusSummary, mostUrgentLayoutStatus, type LayoutStatusSummary } from "./layoutStatusSummary";
import type { LayoutStripGroup } from "./layoutStripGroups";
import LayoutSwitchList from "./LayoutSwitchList";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";

function sumSummaries(summaries: LayoutStatusSummary[]): LayoutStatusSummary {
  return summaries.reduce((total, item) => ({
    running: total.running + item.running,
    waitingInput: total.waitingInput + item.waitingInput,
    blocked: total.blocked + item.blocked,
    idle: total.idle + item.idle,
    total: total.total + item.total,
  }), { running: 0, waitingInput: 0, blocked: 0, idle: 0, total: 0 });
}

export default function LayoutGroupChip({
  group,
  density,
  currentLayoutId,
  liveRootPane,
  statusMap,
  onToggle,
  onSelectLayout,
}: {
  group: LayoutStripGroup;
  density: LayoutBarDensity;
  currentLayoutId: string;
  liveRootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
  onToggle: (collapsed: boolean) => void;
  onSelectLayout: (layoutId: string) => void;
}) {
  const { t } = useTranslation("panes");
  const { label, color } = useWorkspaceAppearance(group.key);
  const [open, setOpen] = useState(false);
  const count = group.members.length;
  const urgent = mostUrgentLayoutStatus(sumSummaries(group.members.map((layout) =>
    deriveLayoutStatusSummary(layout.id === currentLayoutId ? liveRootPane : layout.rootPane, statusMap))));
  const urgentColor = urgent ? TERMINAL_STATUS_PRESENTATION[urgent.status].colorToken : null;
  const toggleLabel = t(group.collapsed ? "expandLayoutGroup" : "collapseLayoutGroup", { name: label });

  const menu = (trigger: ReactElement) => (
    <ContextMenu>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent className="z-[160] w-44">
        <ContextMenuItem onSelect={() => onToggle(!group.collapsed)}>
          {group.collapsed ? <UnfoldHorizontal /> : <FoldHorizontal />}
          {toggleLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  if (!group.collapsed) {
    return menu(
      <button
        type="button"
        data-layout-group={group.key}
        data-collapsed="false"
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded
        onClick={() => onToggle(true)}
        className="flex h-[22px] max-w-[120px] flex-shrink-0 items-center gap-1 rounded-full px-2 text-[length:var(--text-micro)] font-semibold transition-colors duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
        style={{
          color,
          background: `color-mix(in srgb, ${color} 14%, transparent)`,
        }}
      >
        <span className="truncate">{label}</span>
      </button>,
    );
  }

  // 折叠态：两层错开的「底牌」画出一叠卡片的厚度，最上面一张放内容。
  const height = density === "comfortable" ? 40 : 26;
  const layer = (offset: number, opacity: number) => (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-md border"
      style={{
        transform: `translate(${offset}px, ${-offset}px)`,
        borderColor: `color-mix(in srgb, ${color} 40%, var(--app-border))`,
        background: "var(--app-panel-bg)",
        opacity,
      }}
    />
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {menu(
        <PopoverTrigger asChild>
          <button
            type="button"
            data-layout-group={group.key}
            data-collapsed="true"
            aria-label={t("layoutGroupCollapsedLabel", { name: label, count })}
            title={t("layoutGroupCollapsedLabel", { name: label, count })}
            className="group/deck relative mr-1.5 mt-1.5 flex-shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
            style={{ height }}
          >
            {layer(5, 0.55)}
            {layer(2.5, 0.8)}
            <span
              className="relative flex h-full items-center gap-1.5 rounded-md border px-2.5 text-[length:var(--text-row)] transition-colors duration-[var(--dur-fast)] group-hover/deck:bg-[var(--app-hover)]"
              style={{
                borderColor: `color-mix(in srgb, ${color} 55%, var(--app-border))`,
                background: "var(--app-panel-bg)",
                color: "var(--app-text-primary)",
              }}
            >
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color }} />
              <span className="max-w-[96px] truncate font-medium">{label}</span>
              <span
                className="rounded px-1 text-[length:var(--text-micro)] font-semibold tabular-nums"
                style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
              >
                {count}
              </span>
              {urgentColor ? (
                <span
                  data-group-status={urgent?.bucket}
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: urgentColor }}
                />
              ) : null}
            </span>
          </button>
        </PopoverTrigger>,
      )}
      <PopoverContent align="start" className="z-[160] w-64 p-1">
        <LayoutSwitchList
          sections={[{ key: group.key, members: group.members }]}
          hideHeaders
          currentLayoutId={currentLayoutId}
          liveRootPane={liveRootPane}
          statusMap={statusMap}
          onSelect={(layoutId) => {
            setOpen(false);
            onSelectLayout(layoutId);
          }}
        />
        <div className="my-1 h-px" style={{ background: "var(--app-border)" }} />
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[length:var(--text-row)] hover:bg-[var(--app-hover)]"
          style={{ color: "var(--app-text-secondary)" }}
          onClick={() => {
            setOpen(false);
            onToggle(false);
          }}
        >
          <ChevronsLeftRight className="size-3.5" aria-hidden="true" />
          {t("expandLayoutGroup", { name: label })}
        </button>
      </PopoverContent>
    </Popover>
  );
}
