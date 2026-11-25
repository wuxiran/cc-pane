// 布局条右端的「全部布局」下拉（VS Code / JetBrains 式溢出入口）：
// 按工作空间分段、可搜索、带状态；折叠分组里的、滚出视野的布局都能从这里直接切换。
import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { LayoutEntry, PaneNode, TerminalStatusInfo } from "@/types";
import { groupLayoutsByWorkspace } from "./layoutStripGroups";
import LayoutSwitchList from "./LayoutSwitchList";

export default function LayoutAllMenu({
  layouts,
  currentLayoutId,
  liveRootPane,
  statusMap,
  onSelect,
}: {
  layouts: readonly LayoutEntry[];
  currentLayoutId: string;
  liveRootPane: PaneNode;
  statusMap: Map<string, TerminalStatusInfo>;
  onSelect: (layoutId: string) => void;
}) {
  const { t } = useTranslation("panes");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? layouts.filter((layout) => layout.name.toLowerCase().includes(needle))
      : layouts;
    return groupLayoutsByWorkspace(matched, currentLayoutId, liveRootPane);
  }, [layouts, query, currentLayoutId, liveRootPane]);
  const label = t("allLayouts");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-testid="layout-all-trigger"
              className="flex h-[26px] flex-shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[length:var(--text-micro)] tabular-nums transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
              style={{ color: "var(--app-text-tertiary)" }}
            >
              {layouts.length}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="z-[160] w-72 p-1">
        <div
          className="mb-1 flex items-center gap-1.5 rounded-sm border px-2"
          style={{ borderColor: "var(--app-border)" }}
        >
          <Search className="size-3.5 shrink-0" style={{ color: "var(--app-text-tertiary)" }} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            aria-label={t("searchLayouts")}
            placeholder={t("searchLayouts")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const first = sections[0]?.members[0];
              if (!first) return;
              setOpen(false);
              setQuery("");
              onSelect(first.id);
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-[length:var(--text-row)] outline-none"
            style={{ color: "var(--app-text-primary)" }}
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {sections.length === 0 ? (
            <div className="px-2 py-3 text-center text-[length:var(--text-row)]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("noMatchingLayouts")}
            </div>
          ) : (
            <LayoutSwitchList
              sections={sections}
              currentLayoutId={currentLayoutId}
              liveRootPane={liveRootPane}
              statusMap={statusMap}
              onSelect={(layoutId) => {
                setOpen(false);
                setQuery("");
                onSelect(layoutId);
              }}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
