import type { ResourceSortMode } from "@/stores/usePanelPreferencesStore";
import type { WorkspaceGroup } from "./SystemResourcePopover";

export function sortResourceGroups(groups: WorkspaceGroup[], mode: ResourceSortMode, topLabel: string): WorkspaceGroup[] {
  if (mode === "group") return groups;
  const sessions = groups.flatMap(g => g.sessions).sort((a, b) => {
    const delta = mode === "cpu" ? b.cpuPercent - a.cpuPercent : b.memoryBytes - a.memoryBytes;
    return delta || a.sessionId.localeCompare(b.sessionId);
  });
  return [{ name: topLabel, sessions, cpuPercent: sessions.reduce((n, s) => n + s.cpuPercent, 0),
    memoryBytes: sessions.reduce((n, s) => n + s.memoryBytes, 0) }];
}
