import { useEffect, useCallback, useState } from "react";
import { List, ListTree, RefreshCw, Search, SearchX, Workflow } from "lucide-react";
import { useOrchestratorStore } from "@/stores";
import type { FilterTab } from "@/stores/orchestratorState";
import { useTranslation } from "react-i18next";
import { OrchestratorFilterButton, OrchestratorSearchField } from "./OrchestratorFilterBar";
import OrchestratorTaskCard from "./OrchestratorTaskCard";
import OrchestratorTaskTree from "./OrchestratorTaskTree";
import OrchestratorTaskPagination from "@/components/orchestration/OrchestratorTaskPagination";
import type { OpenTerminalOptions } from "@/types";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { SegmentedTabs } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

interface OrchestratorViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  /** 右侧栏内嵌：外层面板头已有标题，这里不再重复 */
  compact?: boolean;
}

const TOOL_BUTTON_CLASS = "size-6 p-0";

function activeToolClass(active: boolean): string {
  return active
    ? "bg-[color-mix(in_srgb,var(--app-accent)_14%,transparent)] text-[var(--app-accent)] hover:text-[var(--app-accent)]"
    : "";
}

export default function OrchestratorView({
  onOpenTerminal: _onOpenTerminal,
  compact = false,
}: OrchestratorViewProps) {
  const { t } = useTranslation(["orchestration", "sidebar"]);
  const bindings = useOrchestratorStore((s) => s.bindings);
  const loading = useOrchestratorStore((s) => s.loading);
  const filterTab = useOrchestratorStore((s) => s.filterTab);
  const filterWorkspace = useOrchestratorStore((s) => s.filterWorkspace);
  const filterProjectPath = useOrchestratorStore((s) => s.filterProjectPath);
  const filterRole = useOrchestratorStore((s) => s.filterRole);
  const searchKeyword = useOrchestratorStore((s) => s.searchKeyword);
  const viewType = useOrchestratorStore((s) => s.viewType);
  const loadBindings = useOrchestratorStore((s) => s.loadBindings);
  const setFilterTab = useOrchestratorStore((s) => s.setFilterTab);
  const setViewType = useOrchestratorStore((s) => s.setViewType);
  const [searchOpen, setSearchOpen] = useState(() => searchKeyword.length > 0);

  useEffect(() => {
    loadBindings();
  }, [loadBindings]);

  const handleRefresh = useCallback(() => {
    loadBindings();
  }, [loadBindings]);

  const clearFilters = useCallback(() => {
    const state = useOrchestratorStore.getState();
    if (state.filterTab !== "all") state.setFilterTab("all");
    if (state.filterWorkspace) state.setFilterWorkspace(null);
    if (state.filterProjectPath) state.setFilterProjectPath(null);
    if (state.filterRole) state.setFilterRole(null);
    if (state.searchKeyword) state.setSearchKeyword("");
    setSearchOpen(false);
  }, []);

  const tabs: Array<{ value: FilterTab; label: string }> = [
    { value: "all", label: t("filter.all") },
    { value: "running", label: t("filter.running") },
    { value: "completed", label: t("filter.done") },
  ];
  const viewModes = [
    { type: "list" as const, icon: List, label: t("view.list") },
    { type: "tree" as const, icon: ListTree, label: t("view.tree") },
  ];
  const filtered = filterTab !== "all"
    || Boolean(filterWorkspace || filterProjectPath || filterRole || searchKeyword);
  const showSearchRow = searchOpen || searchKeyword.length > 0;
  const padX = compact ? "px-2" : "px-3";

  return (
    <div className="flex h-full flex-col">
      {!compact && (
        <div className="flex h-9 shrink-0 items-center px-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
          <span className="min-w-0 truncate text-[length:var(--text-micro)] font-semibold uppercase tracking-wider text-[var(--app-text-secondary)]">
            {t("sidebar:rightDock.orchestration")}
          </span>
        </div>
      )}

      {/* 工具行：状态分段 + 搜索 / 筛选 / 视图 / 刷新；搜索按需展开成第二行 */}
      <div className={cn("flex shrink-0 flex-col gap-1.5 py-1.5", padX)} style={{ borderBottom: "1px solid var(--app-border)" }}>
        <div className="flex min-w-0 items-center gap-1">
          <SegmentedTabs<FilterTab>
            size="sm"
            className="min-w-0 shrink"
            aria-label={t("sidebar.filters")}
            value={filterTab}
            onValueChange={setFilterTab}
            items={tabs}
          />
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <IconTooltipButton
              label={t("sidebar.search")}
              aria-pressed={showSearchRow}
              className={cn(TOOL_BUTTON_CLASS, activeToolClass(showSearchRow))}
              onClick={() => setSearchOpen((open) => (searchKeyword ? true : !open))}
            >
              <Search className="size-3.5" />
            </IconTooltipButton>
            <OrchestratorFilterButton />
            <span aria-hidden className="mx-0.5 h-4 w-px bg-[var(--app-border)]" />
            {viewModes.map(({ type, icon: Icon, label }) => (
              <IconTooltipButton
                key={type}
                label={label}
                aria-pressed={viewType === type}
                className={cn(TOOL_BUTTON_CLASS, activeToolClass(viewType === type))}
                onClick={() => setViewType(type)}
              >
                <Icon className="size-3.5" />
              </IconTooltipButton>
            ))}
            <IconTooltipButton
              label={t("sidebar.refresh")}
              className={TOOL_BUTTON_CLASS}
              onClick={handleRefresh}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </IconTooltipButton>
          </div>
        </div>
        {showSearchRow && <OrchestratorSearchField onClose={() => setSearchOpen(false)} />}
      </div>

      {/* 任务列表 */}
      <div className="app-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-1">
        {bindings.length === 0 && !loading && (
          filtered ? (
            <EmptyState
              icon={SearchX}
              illustration="empty-search"
              title={t("emptyFiltered.title")}
              description={t("emptyFiltered.description")}
              action={{ label: t("emptyFiltered.clear"), onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={Workflow}
              illustration="empty-box"
              title={t("emptyTasks.title")}
              description={t("emptyTasks.description")}
              action={{ label: t("sidebar.refresh"), onClick: handleRefresh }}
            />
          )
        )}
        {viewType === "tree" ? (
          <OrchestratorTaskTree />
        ) : (
          bindings.map((binding) => (
            <OrchestratorTaskCard
              key={binding.id}
              binding={binding}
            />
          ))
        )}
        <OrchestratorTaskPagination />
      </div>
    </div>
  );
}
