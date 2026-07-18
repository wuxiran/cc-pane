import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useOrchestratorStore, useWorkspacesStore } from "@/stores";
import type { TaskBindingRole } from "@/types";
import { getProjectLabel, getProjectName } from "./OrchestratorTaskUtils";

const ROLE_OPTIONS: Array<{ value: TaskBindingRole | null; label: string | null }> = [
  { value: null, label: null },
  { value: "task", label: "🎯" },
  { value: "leader", label: "📋" },
  { value: "worker", label: "⚙️" },
];

function chipStyle(active: boolean): CSSProperties {
  return {
    background: active
      ? "color-mix(in srgb, var(--app-accent) 12%, transparent)"
      : "var(--app-input-bg)",
    color: active ? "var(--app-accent)" : "var(--app-text-secondary)",
    border: "1px solid var(--app-border)",
  };
}

export default function OrchestratorFilterBar() {
  const { t } = useTranslation("orchestration");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const filterWorkspace = useOrchestratorStore((s) => s.filterWorkspace);
  const filterProjectPath = useOrchestratorStore((s) => s.filterProjectPath);
  const filterRole = useOrchestratorStore((s) => s.filterRole);
  const searchKeyword = useOrchestratorStore((s) => s.searchKeyword);
  const setFilterWorkspace = useOrchestratorStore((s) => s.setFilterWorkspace);
  const setFilterProjectPath = useOrchestratorStore((s) => s.setFilterProjectPath);
  const setFilterRole = useOrchestratorStore((s) => s.setFilterRole);
  const setSearchKeyword = useOrchestratorStore((s) => s.setSearchKeyword);

  const selectedWorkspace = filterWorkspace
    ? workspaces.find((workspace) => workspace.name === filterWorkspace)
    : null;
  const availableProjects = selectedWorkspace
    ? selectedWorkspace.projects
    : workspaces.flatMap((workspace) => workspace.projects);
  const selectedProject = availableProjects.find((project) => project.path === filterProjectPath);

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 px-2 py-1.5"
      style={{ borderBottom: "1px solid var(--app-border)" }}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="min-w-0 max-w-[88px] truncate rounded px-2 py-1 text-[11px]"
            style={chipStyle(Boolean(filterWorkspace))}
            title={filterWorkspace ?? t("sidebar.allWorkspaces")}
          >
            {filterWorkspace ?? t("sidebar.workspace")}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2">
          <button
            className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]"
            onClick={() => setFilterWorkspace(null)}
          >
            {t("sidebar.allWorkspaces")}
          </button>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]"
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
            className="min-w-0 max-w-[86px] truncate rounded px-2 py-1 text-[11px]"
            style={chipStyle(Boolean(filterProjectPath))}
            title={selectedProject?.path ?? t("sidebar.allProjects")}
          >
            {selectedProject ? getProjectLabel(selectedProject) : t("sidebar.project")}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <button
            className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]"
            onClick={() => setFilterProjectPath(null)}
          >
            {t("sidebar.allProjects")}
          </button>
          <div className="max-h-60 overflow-y-auto">
            {availableProjects.map((project) => (
              <button
                key={project.id}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--app-hover)]"
                onClick={() => setFilterProjectPath(project.path)}
                title={project.path}
              >
                <span className="min-w-0 flex-1 truncate">{getProjectLabel(project)}</span>
                <span className="text-[10px] text-muted-foreground">
                  {getProjectName(project.path)}
                </span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex shrink-0 overflow-hidden rounded" style={{ border: "1px solid var(--app-border)" }}>
        {ROLE_OPTIONS.map((option) => (
          <button
            key={option.value ?? "all"}
            className="h-6 min-w-6 px-1.5 text-[11px]"
            style={{
              background:
                filterRole === option.value
                  ? "color-mix(in srgb, var(--app-accent) 12%, transparent)"
                  : "var(--app-input-bg)",
              color: filterRole === option.value ? "var(--app-accent)" : "var(--app-text-secondary)",
            }}
            onClick={() => setFilterRole(option.value)}
            title={option.value ?? t("sidebar.allRoles")}
          >
            {option.label ?? t("sidebar.roleAll")}
          </button>
        ))}
      </div>

      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1.5 h-3 w-3 text-muted-foreground" />
        <Input
          className="h-6 rounded px-6 text-xs"
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
          placeholder={t("searchPlaceholder")}
        />
      </div>
    </div>
  );
}
