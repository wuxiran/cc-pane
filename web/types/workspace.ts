/** SSH 连接信息 */
export interface SshConnectionInfo {
  host: string;
  port: number;
  user?: string;
  remotePath: string;
  identityFile?: string;
}

export interface WorkspaceProject {
  id: string;
  path: string;
  alias?: string;
  ssh?: SshConnectionInfo;
}

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  createdAt: string;
  projects: WorkspaceProject[];
  providerId?: string;
  path?: string;
  pinned?: boolean;
  hidden?: boolean;
}
