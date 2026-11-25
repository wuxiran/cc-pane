// 布局切换列表：折叠分组的弹出层与「全部布局」下拉共用。
// 每行：最紧急状态点 + 名称 + tab 数；当前布局高亮并带勾。
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TERMINAL_STATUS_PRESENTATION } from "@/lib/statusPresentation";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import { deriveLayoutStatusSummary, mostUrgentLayoutStatus } from "./layoutStatusSummary";
import { deriveLayoutTypeSummary } from "./layoutTypeSummary";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";

export interface LayoutSwitchSection {
  key: string | null;
  members: LayoutEntry[];
}

function SectionHeader({ name }: { name: string | null }) {
  const { t } = useTranslation("panes");
  const { label, color } = useWorkspaceAppearance(name ?? "");
  return (
    <div
      className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[length:var(--text-micro)] font-semibold"
      style={{ color: "var(--app-text-tertiary)" }}
    >
      {name ? <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: color }} /> : null}
      <span className="truncate">{name ? label : t("layoutsUngrouped")}</span>
    </div>
  );
}

export default function LayoutSwitchList({
  sections,
  hideHeaders = false,
  currentLayoutId,
  liveRootPane,
  statusMap,
  onSelect,
}: {
  sections: readonly LayoutSwitchSection[];
  hideHeaders?: boolean;
  currentLayoutId: string;
  liveRootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
  onSelect: (layoutId: string) => void;
}) {
  return (
    <div role="listbox" className="flex flex-col">
      {sections.map((section) => (
        <div key={section.key ?? "\u0000ungrouped"} role="group">
          {hideHeaders ? null : <SectionHeader name={section.key} />}
          {section.members.map((layout) => {
            const current = layout.id === currentLayoutId;
            const tree = current ? liveRootPane : layout.rootPane;
            const urgent = mostUrgentLayoutStatus(deriveLayoutStatusSummary(tree, statusMap));
            const tabs = deriveLayoutTypeSummary(tree, layout.kind).total;
            return (
              <button
                key={layout.id}
                type="button"
                role="option"
                aria-selected={current}
                data-layout-option={layout.id}
                onClick={() => onSelect(layout.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[length:var(--text-row)] hover:bg-[var(--app-hover)] focus-visible:bg-[var(--app-hover)] focus-visible:outline-none"
                style={{
                  color: "var(--app-text-primary)",
                  background: current ? "var(--app-active-bg)" : undefined,
                }}
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: urgent ? TERMINAL_STATUS_PRESENTATION[urgent.status].colorToken : "transparent" }}
                />
                <span className={`min-w-0 flex-1 truncate ${current ? "font-semibold" : ""}`}>{layout.name}</span>
                <span className="tabular-nums text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                  {tabs}
                </span>
                {current ? <Check className="size-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" /> : <span className="size-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
