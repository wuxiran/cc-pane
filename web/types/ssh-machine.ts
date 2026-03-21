/** SSH 认证方式 */
export type AuthMethod = "password" | "key" | "agent";

/** SSH 机器配置 — 独立实体，可被多个工作空间引用 */
export interface SshMachine {
  id: string;
  name: string;
  host: string;
  port: number;
  user?: string;
  authMethod: AuthMethod;
  identityFile?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** SSH 连通性检测结果 */
export interface SshConnectivityResult {
  reachable: boolean;
  message: string;
  latencyMs: number | null;
}
