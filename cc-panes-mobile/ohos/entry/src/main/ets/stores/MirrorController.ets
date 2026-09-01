import { AppConfig } from '../common/Config';
import { ApiFailure, Err, FailureKind, Result } from '../common/Result';
import { LayoutSnapshot } from '../model/LayoutSnapshot';
import { buildMirrorState, MirrorState } from '../model/MirrorState';
import { SavedSession } from '../model/SavedSession';
import { SessionInfo } from '../model/SessionInfo';
import { LayoutSnapshotApi } from '../services/LayoutSnapshotApi';
import { SessionsApi } from '../services/SessionsApi';
import { AuthPhase, authController } from './AuthController';

let instance: MirrorController | undefined = undefined;

export function mirrorController(): MirrorController {
  if (instance === undefined) {
    instance = new MirrorController();
  }
  return instance;
}

/**
 * 镜像控制器（合并 Dart mirror_controller + sessions_controller 两个 controller，
 * 修复其 localMeta / 轮询数据源分裂缺陷，作为唯一会话数据源）：
 * - 5s 轮询 layout-snapshot/default + /api/sessions 并行拉取 → buildMirrorState 合成；
 * - 轮询失败保留旧数据（仅无旧数据才置 error）；
 * - launch 记 localMeta（进「手机远程会话」组）；killSession 移除 localMeta；
 * - 401 时触发 AuthController.reconnect() 静默重登。
 */
@ObservedV2
export class MirrorController {
  @Trace state: MirrorState = MirrorState.empty();
  @Trace error: ApiFailure | undefined = undefined;

  /** 手机自己 launch 的会话元数据（sessionId → 项目/CLI），进程内缓存。 */
  private localMeta: Map<string, SavedSession> = new Map();
  private timerId: number = -1;
  private inFlight: boolean = false;
  private hasData: boolean = false;
  private started: boolean = false;

  /** AuthReady 后由 UI 调用（幂等）：立即拉一次 + 启动 5s 轮询。 */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.refresh();
    this.timerId = setInterval(() => {
      this.refresh();
    }, AppConfig.SESSION_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
    this.started = false;
  }

  /** 手动刷新（下拉刷新 / launch / kill / 恢复快照后复用）。 */
  async refresh(): Promise<void> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      // 每轮从 AuthController 取当前 client，静默重登换实例后下一轮自动生效
      let snapshotApi: LayoutSnapshotApi = new LayoutSnapshotApi(client);
      let sessionsApi: SessionsApi = new SessionsApi(client);
      let snapPromise = snapshotApi.fetch();
      let listPromise = sessionsApi.list();
      let snapResult = await snapPromise;
      let listResult = await listPromise;

      let running: SessionInfo[] = [];
      if (listResult.ok && listResult.value !== undefined) {
        running = listResult.value;
      }

      if (!snapResult.ok) {
        let failure: ApiFailure = snapResult.failure !== undefined
          ? snapResult.failure
          : new ApiFailure(FailureKind.Local, '未知错误');
        if (failure.kind === FailureKind.Unauthorized) {
          auth.reconnect().catch(() => {
          });
        }
        // 轮询失败保留旧数据，只在没有旧数据时暴露错误
        if (!this.hasData) {
          this.error = failure;
        }
        return;
      }

      this.state = buildMirrorState(snapResult.value, running, this.localMeta, Date.now());
      this.hasData = true;
      this.error = undefined;
    } catch (err) {
      if (!this.hasData) {
        this.error = new ApiFailure(FailureKind.Local, `${err}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** 手机在项目里启动会话（Claude / Codex / 纯终端 / resume）→ 记入 localMeta。
   *  只读模式下前置拦截（不走网络），Err(readOnly) 由 UI 转既有只读 toast。 */
  async launch(
    projectPath: string,
    cliTool: string,
    workspaceName?: string,
    resumeId?: string
  ): Promise<Result<string>> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined) {
      return Err(new ApiFailure(FailureKind.Local, '未连接服务器'));
    }
    if (auth.readOnly()) {
      return Err(new ApiFailure(FailureKind.ReadOnly, '远程只读模式已拦截该操作'));
    }
    let api: SessionsApi = new SessionsApi(client);
    let result = await api.create(
      projectPath,
      cliTool,
      cliTool !== 'none',
      workspaceName,
      resumeId,
      AppConfig.DEFAULT_COLS,
      AppConfig.DEFAULT_ROWS
    );
    if (result.ok && result.value !== undefined) {
      this.localMeta.set(result.value, new SavedSession(
        result.value,
        projectPath,
        undefined,
        undefined,
        workspaceName,
        cliTool,
        undefined,
        resumeId
      ));
      await this.refresh();
    }
    return result;
  }

  /** 关闭会话：只读模式下前置拦截（不走网络），Err(readOnly) 由 UI 转既有只读 toast。 */
  async killSession(sessionId: string): Promise<Result<void>> {
    let auth = authController();
    let client = auth.client;
    if (auth.phase !== AuthPhase.Ready || client === undefined) {
      return Err(new ApiFailure(FailureKind.Local, '未连接服务器'));
    }
    if (auth.readOnly()) {
      return Err(new ApiFailure(FailureKind.ReadOnly, '远程只读模式已拦截该操作'));
    }
    let api: SessionsApi = new SessionsApi(client);
    let result = await api.kill(sessionId);
    this.localMeta.delete(sessionId);
    await this.refresh();
    return result;
  }
}
