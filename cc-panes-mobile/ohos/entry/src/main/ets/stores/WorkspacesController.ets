import { ApiFailure, Err, FailureKind, Result } from '../common/Result';
import { Workspace } from '../model/Workspace';
import { RestoreSnapshotResult, WorkspaceSnapshotSummary } from '../model/WorkspaceSnapshot';
import { WorkspacesApi } from '../services/WorkspacesApi';
import { AuthPhase, authController } from './AuthController';
import { mirrorController } from './MirrorController';

let instance: WorkspacesController | undefined = undefined;

export function workspacesController(): WorkspacesController {
  if (instance === undefined) {
    instance = new WorkspacesController();
  }
  return instance;
}

/** pinned 优先，同组内 displayName 升序（对齐 Dart _sorted；比较语义同 String.compareTo）。 */
function compareWorkspace(a: Workspace, b: Workspace): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.displayName < b.displayName) {
    return -1;
  }
  if (a.displayName > b.displayName) {
    return 1;
  }
  return 0;
}

/**
 * 工作空间树（对齐 Dart workspaces_controller.dart）：
 * 进入首页加载一次 + refresh() 手动刷新；失败置 failure 并保留旧列表。
 */
@ObservedV2
export class WorkspacesController {
  @Trace workspaces: Workspace[] = [];
  @Trace failure: ApiFailure | undefined = undefined;
  @Trace loaded: boolean = false;

  async refresh(): Promise<void> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined) {
      this.workspaces = [];
      return;
    }
    let result = await new WorkspacesApi(client).list();
    if (result.ok && result.value !== undefined) {
      let sorted: Workspace[] = [];
      for (let item of result.value) {
        sorted.push(item);
      }
      sorted.sort(compareWorkspace);
      this.workspaces = sorted;
      this.failure = undefined;
      this.loaded = true;
    } else {
      this.failure = result.failure !== undefined
        ? result.failure
        : new ApiFailure(FailureKind.Local, '未知错误');
    }
  }

  /**
   * 恢复该工作空间最近一次布局快照：逐 entry 重建会话（resume 续接）。
   * 返回 undefined 表示没有可恢复的快照；Ok 结果可读 succeededCount / entries 得到 ok/fail 计数。
   * 注意：快照在服务端按 workspace name（而非 uuid）作为 key 存储。
   */
  async restoreLatestSnapshot(workspace: Workspace): Promise<Result<RestoreSnapshotResult> | undefined> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined) {
      return Err(new ApiFailure(FailureKind.Local, '未连接服务器'));
    }
    let api: WorkspacesApi = new WorkspacesApi(client);

    let snapshotsResult = await api.listSnapshots(workspace.name);
    if (!snapshotsResult.ok || snapshotsResult.value === undefined) {
      return Err(snapshotsResult.failure !== undefined
        ? snapshotsResult.failure
        : new ApiFailure(FailureKind.Local, '未知错误'));
    }
    let list: WorkspaceSnapshotSummary[] = [];
    for (let item of snapshotsResult.value) {
      list.push(item);
    }
    if (list.length === 0) {
      return undefined;
    }
    // savedAt 降序取最新（ISO8601 字典序比较，同 Dart String.compareTo）
    list.sort((a: WorkspaceSnapshotSummary, b: WorkspaceSnapshotSummary): number => {
      if (a.savedAt < b.savedAt) {
        return 1;
      }
      if (a.savedAt > b.savedAt) {
        return -1;
      }
      return 0;
    });
    let result = await api.restoreSnapshot(workspace.name, list[0].id);
    if (result.ok && result.value !== undefined) {
      mirrorController().refresh().catch(() => {
      });
    }
    return result;
  }
}
