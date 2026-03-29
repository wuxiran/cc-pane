/**
 * 终端会话恢复服务 — invoke 封装
 */
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession } from "@/types";

class SessionRestoreService {
  /** 保存终端会话元数据 */
  async save(sessions: SavedSession[]): Promise<void> {
    return invoke("save_terminal_sessions", { sessions });
  }

  /** 加载已保存的终端会话 */
  async load(): Promise<SavedSession[]> {
    return invoke("load_terminal_sessions");
  }

  /** 清空已保存的终端会话 */
  async clear(): Promise<void> {
    return invoke("clear_terminal_sessions");
  }

  /** 加载指定会话的输出内容 */
  async loadOutput(sessionId: string): Promise<string[] | null> {
    return invoke("load_session_output", { sessionId });
  }

  /** 清除指定会话的输出文件 */
  async clearOutput(sessionId: string): Promise<void> {
    return invoke("clear_session_output", { sessionId });
  }
}

export const sessionRestoreService = new SessionRestoreService();
