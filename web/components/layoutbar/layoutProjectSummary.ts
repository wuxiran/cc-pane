import { collectTerminalSessionIds, collectTerminalTabs } from "@/lib/paneSessions";
import type {
  PaneNode,
  Tab,
  TerminalStatusInfo,
  TerminalStatusType,
  Workspace,
  WorkspaceProject,
} from "@/types";
import { aggregatePaneStatus } from "@/utils/layoutStatus";
import { getProjectName } from "@/utils/path";

const MAX_VISIBLE_PROJECTS = 2;

export interface LayoutProjectSummaryItem {
  id: string;
  name: string;
  status: TerminalStatusType | null;
}

export interface LayoutProjectSummary {
  projects: LayoutProjectSummaryItem[];
  overflow: number;
}

function projectById(workspaces: Workspace[]): Map<string, WorkspaceProject> {
  return new Map(
    workspaces.flatMap((workspace) => workspace.projects.map((project) => [project.id, project] as const)),
  );
}

function statusesForTab(
  tab: Tab,
  statusMap: Map<string, TerminalStatusInfo>,
): TerminalStatusType[] {
  return collectTerminalSessionIds(tab)
    .map((sessionId) => statusMap.get(sessionId)?.status)
    .filter((status): status is TerminalStatusType => status !== undefined);
}

export function deriveLayoutProjectSummary(
  rootPane: PaneNode,
  workspaces: Workspace[],
  statusMap: Map<string, TerminalStatusInfo>,
): LayoutProjectSummary {
  const knownProjects = projectById(workspaces);
  const derived = new Map<string, { name: string; statuses: TerminalStatusType[] }>();

  for (const tab of collectTerminalTabs(rootPane)) {
    const id = tab.projectId.trim();
    if (!id) continue;

    const existing = derived.get(id);
    if (existing) {
      existing.statuses.push(...statusesForTab(tab, statusMap));
      continue;
    }

    const knownProject = knownProjects.get(id);
    const path = knownProject?.path || tab.projectPath;
    derived.set(id, {
      name: knownProject?.alias || getProjectName(path) || tab.title,
      statuses: statusesForTab(tab, statusMap),
    });
  }

  const projects = Array.from(derived, ([id, project]) => ({
    id,
    name: project.name,
    status: aggregatePaneStatus(project.statuses),
  }));

  return {
    projects: projects.slice(0, MAX_VISIBLE_PROJECTS),
    overflow: Math.max(0, projects.length - MAX_VISIBLE_PROJECTS),
  };
}
