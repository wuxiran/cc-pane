// `orchestrator-launch-task` 事件的 payload 契约（对应 Rust 侧
// `OrchestratorLaunchEvent`，`src-tauri/src/services/orchestrator_service.rs`）。
//
// 单列成文件是为了让监听器专注于落位逻辑；改这里务必同步改 Rust 侧结构体。
import type { LaunchProviderSelection, SshConnectionInfo, WslLaunchInfo } from "@/types";

export interface OrchestratorLaunchPayload {
  taskId: string;
  sessionId: string;
  projectPath: string;
  projectId: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  title?: string;
  resumeId?: string;  // 对应 Rust OrchestratorLaunchEvent.resume_id
  paneId?: string;
  layoutId?: string;
  layoutName?: string;
  /**
   * 后端预分配的出生锚点，已写进 daemon 不可变出生凭证。**必须原样采用**：
   * 前端另起 id 会让凭证锚点与真实窗格对不上，该会话重启后无法自动接管，
   * 且凭证不可改写、事后补不回来。缺失时（旧后端）退回前端自行生成。
   */
  tabId?: string;
  terminalPaneId?: string;
  cliTool?: string;
  runtimeKind?: string;
  runtimeSource?: string;
  notice?: string;
  wsl?: WslLaunchInfo;
  ssh?: SshConnectionInfo;
  /**
   * 新会话落位方式（后端 launch_task 的 placement 参数）：
   * `"beside"`（默认，调用者 pane 旁边分屏）| `"tab"` / `"background"`（调用者 pane 标签页）。
   */
  placement?: string;
  /**
   * Caller's pty_session_id when this launch was triggered by another
   * cc-panes-managed Claude via MCP `launch_task`. Used by the frontend to
   * resolve a `parentTabId` for hierarchical numbering (#N.M).
   */
  parentSessionId?: string;
}