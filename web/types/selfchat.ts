/**
 * Self-Chat（自我对话）类型定义
 *
 * 与 CC-Panes 应用自身对话，通过 ccbook:* skill 操控应用。
 */

/** 自我对话会话状态 */
export type SelfChatStatus = "initializing" | "running" | "exited";

/** 自我对话会话 */
export interface SelfChatSession {
  id: string;
  appCwd: string;              // CC-Panes 项目根目录
  ptySessionId: string | null;
  status: SelfChatStatus;
  systemPrompt: string | null;
}
