import { invoke } from "@tauri-apps/api/core";

export interface JournalIndex {
  activeFile: string;
  totalSessions: number;
  lastActive: string;
}

/**
 * Journal 服务 - 管理会话日志
 */
export const journalService = {
  /**
   * 添加会话摘要
   */
  async addSession(
    workspaceName: string,
    title: string,
    summary: string,
    commits: string[] = []
  ): Promise<number> {
    return invoke<number>("add_journal_session", {
      workspaceName,
      title,
      summary,
      commits,
    });
  },

  /**
   * 获取 journal 索引信息
   */
  async getIndex(workspaceName: string): Promise<JournalIndex> {
    return invoke<JournalIndex>("get_journal_index", { workspaceName });
  },

  /**
   * 获取最近的 journal 内容
   */
  async getRecentJournal(workspaceName: string): Promise<string> {
    return invoke<string>("get_recent_journal", { workspaceName });
  },
};
