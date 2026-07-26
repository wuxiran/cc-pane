/**
 * 终端会话恢复服务 — invoke 封装
 */
import type { SavedSession } from "@/types";
import { apiDelete, apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";

class SessionRestoreService {
  /** 保存终端会话元数据 */
  async save(sessions: SavedSession[]): Promise<void> {
    return invokeOrApi<void>("save_terminal_sessions", { sessions }, () =>
      apiNoContent("/api/terminal-sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessions),
      }),
    );
  }

  /** 加载已保存的终端会话 */
  async load(): Promise<SavedSession[]> {
    return invokeOrApi<SavedSession[]>("load_terminal_sessions", undefined, () =>
      apiGet<SavedSession[]>("/api/terminal-sessions"),
    );
  }

  /** 清空已保存的终端会话 */
  async clear(): Promise<void> {
    return invokeOrApi<void>("clear_terminal_sessions", undefined, () =>
      apiDelete("/api/terminal-sessions"),
    );
  }

  /** Delete stale rows only from a complete snapshot of one daemon generation. */
  async prune(
    daemonGeneration: number,
    capturedAtMs: number,
    liveSessionIds: string[],
  ): Promise<number> {
    const payload = { daemonGeneration, capturedAtMs, liveSessionIds };
    return invokeOrApi<number>("prune_terminal_sessions", payload, () =>
      apiJson<number>("/api/terminal-sessions/prune", "POST", payload),
    );
  }

  /** 加载指定会话的输出内容 */
  async loadOutput(sessionId: string): Promise<string[] | null> {
    return invokeOrApi<string[] | null>("load_session_output", { sessionId }, () =>
      apiGet<string[] | null>(`/api/terminal-sessions/${encodeURIComponent(sessionId)}/output`),
    );
  }

  /** 清除指定会话的输出文件 */
  async clearOutput(sessionId: string): Promise<void> {
    return invokeOrApi<void>("clear_session_output", { sessionId }, () =>
      apiDelete(`/api/terminal-sessions/${encodeURIComponent(sessionId)}/output`),
    );
  }
}

export const sessionRestoreService = new SessionRestoreService();
