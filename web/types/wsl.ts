/** WSL 分发版运行状态 */
export type WslDistroState = "running" | "stopped" | "installing" | "unknown";

/** WSL 分发版信息 */
export interface WslDistro {
  /** 分发版名称（如 Ubuntu, Debian） */
  name: string;
  /** 运行状态 */
  state: WslDistroState;
  /** WSL 版本（1 或 2） */
  wslVersion: number;
  /** 是否为默认分发版 */
  isDefault: boolean;
  /** 默认用户名 */
  defaultUser: string | null;
  /** 是否已作为 SSH Machine 导入 */
  alreadyImported: boolean;
}
