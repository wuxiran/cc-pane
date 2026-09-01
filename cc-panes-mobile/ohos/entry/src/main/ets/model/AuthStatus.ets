import { jsonGetBool, jsonGetString } from '../common/Json';

/**
 * GET /api/auth/status 响应（cc-panes-web web_auth.rs AuthStatus，camelCase）。
 */
export class AuthStatus {
  readonly authRequired: boolean;
  readonly authenticated: boolean;
  readonly username: string;
  readonly passwordConfigured: boolean;

  /** 本请求来源在远程只读模式下是否被限制为只读 */
  readonly readOnly: boolean;

  /** 服务端是否开启"已登录远程会话可写" */
  readonly remoteAuthenticatedWrite: boolean;

  constructor(
    authRequired: boolean,
    authenticated: boolean,
    username: string,
    passwordConfigured: boolean,
    readOnly: boolean,
    remoteAuthenticatedWrite: boolean
  ) {
    this.authRequired = authRequired;
    this.authenticated = authenticated;
    this.username = username;
    this.passwordConfigured = passwordConfigured;
    this.readOnly = readOnly;
    this.remoteAuthenticatedWrite = remoteAuthenticatedWrite;
  }

  static fromJson(rec: Record<string, Object>): AuthStatus {
    return new AuthStatus(
      jsonGetBool(rec, 'authRequired', false),
      jsonGetBool(rec, 'authenticated', false),
      jsonGetString(rec, 'username', ''),
      jsonGetBool(rec, 'passwordConfigured', false),
      jsonGetBool(rec, 'readOnly', false),
      jsonGetBool(rec, 'remoteAuthenticatedWrite', false)
    );
  }
}
