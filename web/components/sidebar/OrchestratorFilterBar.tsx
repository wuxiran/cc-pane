import { useEffect, useRef } from "react";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { SegmentedTabs } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { useOrchestratorStore, useWorkspacesStore } from "@/stores";
import type { TaskBindingRole } from "@/types";
import { getProjectLabel, getProjectName } from "./OrchestratorTaskUtils";

type RoleValue = TaskBindingRole | "all";
const ROLE_VALUES: RoleValue[] = ["all", "task", "leader", "worker"];

const CHIP_CLASS =
  "flex h-7 min-w-0 items-center gap-1 rounded-md border border-[var(--app-border)] px-2 text-left text-xs transition-colors hover:bg-[var(--app-hover)]";

function chipTone(active: boolean): string {
  return active
    ? "bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] text-[var(--app-accent)]"
    : "bg-[var(--app-input-bg)] text-[var(--app-text-secondary)]";
}

const MENU_ROW_CLASS = "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]";

/** 工作空间 / 项目 / 角色筛选：低频动作，收进一个筛选按钮的浮层里。 */
export function OrchestratorFilterButton() {
  const { t } = useTranslation("orchestration");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const filterWorkspace = useOrchestratorStore((s) => s.filterWorkspace);
  const filterProjectPath = useOrchestratorStore((s) => s.filterProjectPath);
  const filterRole = useOrchestratorStore((s) => s.filterRole);
  const setFilterWorkspace = useOrchestratorStore((s) => s.setFilterWorkspace);
  const setFilterProjectPath = useOrchestratorStore((s) => s.setFilterProjectPath);
  const setFilterRole = useOrchestratorStore((s) => s.setFilterRole);

  const selectedWorkspace = filterWorkspace
    ? workspaces.find((workspace) => workspace.name === filterWorkspace)
    : null;
  const availableProjects = selectedWorkspace
    ? selectedWorkspace.projects
    : workspaces.flatMap((workspace) => workspace.projects);
  const selectedProject = availableProjects.find((project) => project.path === filterProjectPath);
  const hasActiveFilters = Boolean(filterWorkspace || filterProjectPath || filterRole);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconTooltipButton
          label={t("sidebar.filters")}
          aria-pressed={hasActiveFilters}
          className={cn("relative size-6 p-0", hasActiveFilters && "text-[var(--app-accent)]")}
        >
          <SlidersHorizontal className="size-3.5" />
          {hasActiveFilters && (
            <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-[var(--app-accent)]" />
          )}
        </IconTooltipButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-2">
        <div className="grid grid-cols-2 gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={cn(CHIP_CLASS, chipTone(Boolean(filterWorkspace)))}>
                <span className="min-w-0 flex-1 truncate">{filterWorkspace ?? t("sidebar.workspace")}</span>
                <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2">
              <button type="button" className={MENU_ROW_CLASS} onClick={() => setFilterWorkspace(null)}>
                {t("sidebar.allWorkspaces")}
              </button>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={MENU_ROW_CLASS}
                  onClick={() => setFilterWorkspace(workspace.name)}
                >
                  {workspace.alias || workspace.name}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(CHIP_CLASS, chipTone(Boolean(filterProjectPath)))}
                title={selectedProject?.path}
              >
                <span className="min-w-0 flex-1 truncate">
                  {selectedProject ? getProjectLabel(selectedProject) : t("sidebar.project")}
                </span>
                <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <button type="button" className={MENU_ROW_CLASS} onClick={() => setFilterProjectPath(null)}>
                {t("sidebar.allProjects")}
              </button>
              <div className="max-h-60 overflow-y-auto">
                {availableProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className={cn(MENU_ROW_CLASS, "flex items-center gap-2")}
                    onClick={() => setFilterProjectPath(project.path)}
                    title={project.path}
                  >
                    <span className="min-w-0 flex-1 truncate">{getProjectLabel(project)}</span>
                    <span className="text-[length:var(--text-micro)] text-muted-foreground">
                      {getProjectName(project.path)}
                    </span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <SegmentedTabs<RoleValue>
          size="sm"
          className="grid w-full grid-cols-4"
          aria-label={t("sidebar.allRoles")}
          value={filterRole ?? "all"}
          onValueChange={(value) => setFilterRole(value === "all" ? null : value)}
          items={ROLE_VALUES.map((value) => ({
            value,
            label: value === "all" ? t("sidebar.roleAll") : t(`role.${value}`),
          }))}
        />

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="xs"
            className="w-full"
            onClick={() => {
              if (filterWorkspace) setFilterWorkspace(null);
              if (filterProjectPath) setFilterProjectPath(null);
              if (filterRole) setFilterRole(null);
            }}
          >
            {t("emptyFiltered.clear")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface OrchestratorSearchFieldProps {
  onClose: () => void;
}

/** 展开后的搜索行：自动聚焦，Esc / 关闭按钮清空关键字并收起。 */
export function OrchestratorSearchField({ onClose }: OrchestratorSearchFieldProps) {
  const { t } = useTranslation("orchestration");
  const searchKeyword = useOrchestratorStore((s) => s.searchKeyword);
  const setSearchKeyword = useOrchestratorStore((s) => s.setSearchKeyword);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => {
    if (searchKeyword) setSearchKeyword("");
    onClose();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--app-text-tertiary)]" />
      <Input
        ref={inputRef}
        className="h-7 rounded-md pl-6 pr-7 text-xs md:text-xs"
        value={searchKeyword}
        onChange={(event) => setSearchKeyword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        placeholder={t("searchPlaceholder")}
      />
      <IconTooltipButton
        label={t("sidebar.closeSearch")}
        className="absolute right-1 top-1/2 size-5 -translate-y-1/2 p-0"
        onClick={close}
      >
        <X className="size-3" />
      </IconTooltipButton>
    </div>
  );
}
