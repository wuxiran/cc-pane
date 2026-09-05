// TerminalView 的 props 类型。从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import type { CliTool, CreateSessionRequest, SshConnectionInfo, TerminalLaunchError, WslLaunchInfo } from "@/types";
import type { ViewRole } from "@/stores/useTabViewStateStore";
import type { RestoreLaunchState } from "../terminalRestoreQueue";

export interface TerminalViewProps {
  sessionId: string | null;
  /** One-shot launch identity reserved for, or used by, this terminal leaf. */
  launchId?: string;
  /** A remount after a failed launch must not reuse the failed attempt's identity. */
  launchAttempt?: number;
  projectPath: string;
  /**
   * Whether this terminal belongs to the current top-level layout.
   * 独立于可见性单源的 layout 级判据（后台布局的延迟恢复语义靠它，store
   * 三档不表达「为什么不可见」）。
   */
  layoutActive?: boolean;
  /** False for read-only/shared PTY mirrors that must only fit their local xterm view. */
  drivesBackendPty?: boolean;
  /** Canvas mirror geometry and local zoom controls. */
  resizeBackendPty?: boolean; layoutFitKey?: string | number;
  initialTerminalFontSize?: number; terminalZoomPersistenceKey?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: CreateSessionRequest["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  resumeId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  /** 首启注入的用户 prompt；session 创建成功后经 clearTabInitialPrompt 清除，restore 路径不传 */
  initialPrompt?: string;
  /** per-launch YOLO 覆盖：undefined = 跟随 launch profile */
  yoloMode?: boolean;
  adapterOptions?: CreateSessionRequest["adapterOptions"];
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  /** Whether the tab is restoring output from a saved session. */
  restoring?: boolean;
  /** Saved session id used to replay persisted terminal output. */
  savedSessionId?: string;
  /** Persistent daemon lease state. Read-only terminals still receive output. */
  readOnly?: boolean;
  /** Pane id used to clear restoring state after recovery finishes. */
  paneId?: string;
  /** Tab id used to clear restoring state after recovery finishes. */
  tabId?: string;
  /**
   * 可见性聚合的归属键（docs/78）。降档/休眠读它去查
   * useTabViewStateStore.aggregate —— 判据是「任一视图可见」，不是本视图可见。
   *
   * 与 tabId 分开：tabId 会被 findTabAcrossLayouts / updateTerminalLaunchId 当作
   * 真标签 id 用，而 SelfChat 之类的视图没有 tab，owner 却必须有。
   * 不传（如星标镜像）= 本视图不注册降档。
   */
  visibilityOwnerId?: string;
  /** 本视图在可见性单源里的角色（默认 primary）。双写断言按 role 取本视图条目。 */
  viewRole?: ViewRole;
  /**
   * tab 内 leaf 焦点路由（分屏终端专用）：store 的 active 是 tab 级，同一 tab
   * 的多个 leaf 必须再按此 prop 分焦点——否则分屏多 leaf 同时获焦、同时触发
   * WebGL 恢复。不传（弹窗/SelfChat/镜像等单 leaf 视图）= true。
   */
  leafFocused?: boolean;
  onRestoreLaunchState?: (state: RestoreLaunchState) => void;
  onLaunchError?: (error: TerminalLaunchError) => void;
  onSessionCreated: (sessionId: string) => void;
  onSessionExited?: (exitCode: number) => void;
  /** Optional SSH reconnect callback for disconnected sessions. */
  onReconnect?: () => Promise<string | null>;
}
