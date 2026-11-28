// 项目改路径后迁移历史会话：只有桌面端（要读写本机 ~/.claude、~/.codex）。
import type { SessionRelocationReport, SessionRelocationRequest } from "@/types/sessionRelocation";
import { invokeOrApi } from "./apiClient";

export const sessionRelocationService = {
  relocate(request: SessionRelocationRequest): Promise<SessionRelocationReport> {
    return invokeOrApi<SessionRelocationReport>("relocate_project_sessions", { request }, async () => {
      throw new Error("Session relocation is only available in the desktop app");
    });
  },
};
