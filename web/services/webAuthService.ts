import { apiGet, apiJson } from "./apiClient";

export interface WebAuthStatus {
  authRequired: boolean;
  authenticated: boolean;
  username: string;
  passwordConfigured: boolean;
  allowLan: boolean;
  lockOnIdleMinutes: number;
  /** 本请求来源在远程只读模式下是否被限制为只读 */
  readOnly: boolean;
}

export interface WebLoginRequest {
  username: string;
  password: string;
}

export const webAuthService = {
  status(): Promise<WebAuthStatus> {
    return apiGet<WebAuthStatus>("/api/auth/status");
  },

  async login(request: WebLoginRequest): Promise<void> {
    await apiJson<{ authenticated: boolean }>("/api/auth/login", "POST", request);
  },

  async lock(): Promise<void> {
    await apiJson<{ locked: boolean }>("/api/auth/logout", "POST", {});
  },
};
