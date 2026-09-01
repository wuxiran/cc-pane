import { http } from '@kit.NetworkKit';
import { Result } from '../common/Result';
import { asArray, asRecord } from '../common/Json';
import { Workspace } from '../model/Workspace';
import { RestoreSnapshotResult, WorkspaceSnapshotSummary } from '../model/WorkspaceSnapshot';
import { ApiClient } from './ApiClient';

/** /api/workspaces + /api/workspace-snapshots —— 工作空间树与布局快照。 */
export class WorkspacesApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  list(): Promise<Result<Workspace[]>> {
    return this.client.requestJson<Workspace[]>(
      http.RequestMethod.GET,
      '/api/workspaces',
      (root: Object | null): Workspace[] => {
        let arr: Object[] | undefined = asArray(root);
        if (arr === undefined) {
          throw new Error('响应不是 JSON 数组');
        }
        let out: Workspace[] = [];
        for (let item of arr) {
          let rec: Record<string, Object> | undefined = asRecord(item);
          if (rec !== undefined) {
            out.push(Workspace.fromJson(rec));
          }
        }
        return out;
      }
    );
  }

  listSnapshots(workspaceId: string): Promise<Result<WorkspaceSnapshotSummary[]>> {
    return this.client.requestJson<WorkspaceSnapshotSummary[]>(
      http.RequestMethod.GET,
      `/api/workspace-snapshots/${workspaceId}`,
      (root: Object | null): WorkspaceSnapshotSummary[] => {
        let arr: Object[] | undefined = asArray(root);
        if (arr === undefined) {
          throw new Error('响应不是 JSON 数组');
        }
        let out: WorkspaceSnapshotSummary[] = [];
        for (let item of arr) {
          let rec: Record<string, Object> | undefined = asRecord(item);
          if (rec !== undefined) {
            out.push(WorkspaceSnapshotSummary.fromJson(rec));
          }
        }
        return out;
      }
    );
  }

  /** 按快照重建一组会话（各自带 resumeId 续接对话上下文）。 */
  restoreSnapshot(workspaceId: string, snapshotId: string): Promise<Result<RestoreSnapshotResult>> {
    return this.client.requestJson<RestoreSnapshotResult>(
      http.RequestMethod.POST,
      `/api/workspace-snapshots/${workspaceId}/${snapshotId}/restore`,
      (root: Object | null): RestoreSnapshotResult => {
        let rec: Record<string, Object> | undefined = asRecord(root);
        if (rec === undefined) {
          throw new Error('响应不是 JSON 对象');
        }
        return RestoreSnapshotResult.fromJson(rec);
      }
    );
  }
}
