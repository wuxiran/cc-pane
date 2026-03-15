/**
 * 标签与终端相关类型定义
 */

/** CLI 工具类型 */
export type CliTool = "none" | "claude" | "codex";

/** 通用标签 */
export interface Tab {
  id: string;
  title: string;
  contentType: "terminal" | "mcp-config" | "skill-manager" | "memory-manager" | "file-explorer" | "editor";
  projectId: string;
  projectPath: string;
  sessionId: string | null; // 终端特有，其他类型可忽略
  pinned?: boolean;
  minimized?: boolean;
  resumeId?: string; // Claude resume 会话 ID
  workspaceName?: string; // 所属工作空间名称（用于启动 TUI）
  providerId?: string; // 关联的 Provider ID
  workspacePath?: string; // 工作空间根目录路径（用于 claude --add-dir 模式）
  launchClaude?: boolean; // 是否启动 Claude Code CLI（兼容旧版）
  cliTool?: CliTool; // CLI 工具类型（优先于 launchClaude）
  filePath?: string; // 编辑器打开的文件绝对路径
  dirty?: boolean; // 是否有未保存修改
  reclaimKey?: number; // 回收时递增，作为 React key 触发 remount
}

/** 终端会话状态 */
export interface TerminalSession {
  id: string;
  projectPath: string;
  cols: number;
  rows: number;
  running: boolean;
}

/** 创建终端会话请求 */
export interface CreateSessionRequest {
  projectPath: string;
  cols: number;
  rows: number;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  launchClaude?: boolean;
  cliTool?: CliTool;
  resumeId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
}

/** 终端输出事件 */
export interface TerminalOutput {
  sessionId: string;
  data: string;
}

/** 终端调整大小请求 */
export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}
