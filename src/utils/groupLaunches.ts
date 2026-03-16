import type { LaunchRecord } from "@/services";

export interface WorkspaceGroup {
  workspaceName: string;
  records: LaunchRecord[];
}

/**
 * 将启动记录按工作空间名称分组，只保留有 claudeSessionId 的记录。
 * 无 workspaceName 的归入"未分组"。
 */
export function groupByWorkspace(records: LaunchRecord[], ungroupedLabel: string): WorkspaceGroup[] {
  const filtered = records.filter(r => !!r.claudeSessionId);
  const map = new Map<string, LaunchRecord[]>();

  for (const record of filtered) {
    const key = record.workspaceName || ungroupedLabel;
    const list = map.get(key);
    if (list) {
      list.push(record);
    } else {
      map.set(key, [record]);
    }
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspaceName, recs] of map) {
    groups.push({ workspaceName, records: recs });
  }

  // "未分组" 放到最后
  groups.sort((a, b) => {
    if (a.workspaceName === ungroupedLabel) return 1;
    if (b.workspaceName === ungroupedLabel) return -1;
    return a.workspaceName.localeCompare(b.workspaceName);
  });

  return groups;
}
