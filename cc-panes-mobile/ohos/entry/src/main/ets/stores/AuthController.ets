import { ApiFailure, FailureKind } from '../common/Result';
import { AuthStatus } from '../model/AuthStatus';
import { ServerProfile } from '../model/ServerProfile';
import { ApiClient } from '../services/ApiClient';
import { AuthApi } from '../services/AuthApi';
import { ServerStore } from './ServerStore';

/** 连接 + 登录四态状态机（对齐 Dart AuthState 派生类族）。 */
export enum AuthPhase {
  /** 尚未配置任何服务器 */
  NoProfile = 'noProfile',
  Connecting = 'connecting',
  /** 已连接并可用（authenticated 或服务端未开鉴权） */
  Ready = 'ready',
  /** 需要用户交互（密码错误 / 静默重登失败 / 网络错误） */
  Failed = 'failed',
}

let instance: AuthController | undefined = undefined;

export function authController(): AuthController {
  if (instance === undefined) {
    instance = new AuthController();
  }
  return instance;
}

/**
 * 登录生命周期（时序对齐 PLAN 4.1 与 Dart auth_controller.dart）：
 * 启动 → 读当前 profile → status 探测 → 已认证/免鉴权直达 /
 * 用存储凭证静默登录 → 再 status → 失败才落到 Failed 让 UI 弹登录页。
 */
@ObservedV2
export class AuthController {
  @Trace phase: AuthPhase = AuthPhase.NoProfile;
  @Trace authStatus: AuthStatus | undefined = undefined;
  /** 当前选中的 profile（登录失败时供 ConnectPage 预填表单）。 */
  @Trace profile: ServerProfile | undefined = undefined;
  @Trace failure: ApiFailure | undefined = undefined;

  /** 当前连接的 HTTP 客户端（phase==Ready 时有效；connectWith 换 profile 时整体重建）。 */
  client: ApiClient | undefined = undefined;

  private connecting: boolean = false;
  /** connecting 期间收到 connectWith 的最新 profile：当前尝试 settle 后自动用它重连一次。 */
  private pendingProfile: ServerProfile | undefined = undefined;
  private refreshingStatus: boolean = false;

  /** 应用启动时调用：读 ServerStore.current，无 profile → NoProfile，有 → 静默连接。 */
  async bootstrap(): Promise<void> {
    try {
      let store: ServerStore = ServerStore.getInstance();
      await store.load();
      let profile: ServerProfile | undefined = store.current();
      if (profile === undefined) {
        this.phase = AuthPhase.NoProfile;
        return;
      }
      await this.connect(profile);
    } catch (err) {
      this.fail(new ApiFailure(FailureKind.Local, `${err}`));
    }
  }

  private async connect(profile: ServerProfile): Promise<void> {
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    this.phase = AuthPhase.Connecting;
    this.profile = profile;
    this.failure = undefined;
    this.authStatus = undefined;
    try {
      let client: ApiClient = await ApiClient.create(profile);
      // 403 READ_ONLY 钩子：服务端中途收紧只读时实时重拉 status（不打断原请求的 Result）。
      client.onReadOnlyDetected = (): void => {
        this.refreshAuthStatus().catch((): void => {
        });
      };
      this.client = client;
      let authApi: AuthApi = new AuthApi(client);

      let statusResult = await authApi.status();
      if (!statusResult.ok || statusResult.value === undefined) {
        this.fail(derefFailure(statusResult.failure));
        return;
      }
      let status: AuthStatus = statusResult.value;
      if (!status.authRequired || status.authenticated) {
        this.ready(status);
        return;
      }

      // cookie 过期或首次连接：用存储凭证静默登录
      let loginResult = await authApi.login(profile.username, profile.password);
      if (!loginResult.ok) {
        this.fail(derefFailure(loginResult.failure));
        return;
      }
      if (loginResult.value !== true) {
        this.fail(new ApiFailure(FailureKind.Unauthorized, '用户名或密码错误'));
        return;
      }

      let refreshed = await authApi.status();
      if (!refreshed.ok || refreshed.value === undefined) {
        this.fail(derefFailure(refreshed.failure));
        return;
      }
      this.ready(refreshed.value);
    } catch (err) {
      this.fail(new ApiFailure(FailureKind.Local, `${err}`));
    } finally {
      this.connecting = false;
      // connecting 期间被 connectWith 覆盖的意图：当前尝试 settle 后自动用 pending 重连一次
      let pending: ServerProfile | undefined = this.pendingProfile;
      this.pendingProfile = undefined;
      if (pending !== undefined) {
        await this.connect(pending);
      }
    }
  }

  private ready(status: AuthStatus): void {
    this.authStatus = status;
    this.failure = undefined;
    this.phase = AuthPhase.Ready;
  }

  private fail(failure: ApiFailure): void {
    this.failure = failure;
    this.authStatus = undefined;
    this.client = undefined;
    this.phase = AuthPhase.Failed;
  }

  /** 保存（或更新）profile 并立即连接。供 ConnectPage 调用。
   *  connecting 中被调用时不打断当前尝试：保存为 pending，settle 后自动重连（P2-03）。 */
  async connectWith(profile: ServerProfile): Promise<void> {
    let store: ServerStore = ServerStore.getInstance();
    await store.load();
    await store.upsertAndSelect(profile);
    if (this.connecting) {
      this.pendingProfile = profile;
      return;
    }
    await this.connect(profile);
  }

  /** 401 时由调用方触发：重新跑一遍连接流程（含静默重登）。 */
  async reconnect(): Promise<void> {
    let store: ServerStore = ServerStore.getInstance();
    await store.load();
    let profile: ServerProfile | undefined = store.current();
    if (profile === undefined) {
      this.phase = AuthPhase.NoProfile;
      this.client = undefined;
      return;
    }
    await this.connect(profile);
  }

  /** 本请求来源在远程只读模式下是否被限制为只读。 */
  readOnly(): boolean {
    return this.authStatus !== undefined && this.authStatus.readOnly;
  }

  /**
   * 403 READ_ONLY 回调（ApiClient.onReadOnlyDetected）：重拉 status 让 readOnly 实时收紧。
   * 静默失败：维持旧值，下次 403 会再触发。
   */
  async refreshAuthStatus(): Promise<void> {
    if (this.refreshingStatus || this.phase !== AuthPhase.Ready) {
      return;
    }
    let client: ApiClient | undefined = this.client;
    if (client === undefined) {
      return;
    }
    this.refreshingStatus = true;
    try {
      let statusResult = await new AuthApi(client).status();
      if (statusResult.ok && statusResult.value !== undefined) {
        this.authStatus = statusResult.value;
      }
    } catch (err) {
      // 静默：readOnly 维持旧值
    } finally {
      this.refreshingStatus = false;
    }
  }
}

function derefFailure(failure: ApiFailure | undefined): ApiFailure {
  return failure !== undefined ? failure : new ApiFailure(FailureKind.Local, '未知错误');
}
