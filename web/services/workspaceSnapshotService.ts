import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceSnapshot, WorkspaceSnapshotSummary } from "@/types";

export const workspaceSnapshotService = {
  list(workspaceId: string): Promise<WorkspaceSnapshotSummary[]> {
    return invoke<WorkspaceSnapshotSummary[]>("list_workspace_snapshots", { workspaceId });
  },

  get(workspaceId: string, snapshotId: string): Promise<WorkspaceSnapshot | null> {
    return invoke<WorkspaceSnapshot | null>("get_workspace_snapshot", {
      workspaceId,
      snapshotId,
    });
  },

  remove(workspaceId: string, snapshotId: string): Promise<boolean> {
    return invoke<boolean>("delete_workspace_snapshot", {
      workspaceId,
      snapshotId,
    });
  },
};
