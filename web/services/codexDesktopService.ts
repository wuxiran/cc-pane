import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { isCodexThreadId, isLocalCodexPath, type CodexOpenTarget } from "@/lib/codexIntegration";

/** The backend validates the target and opens its encoded codex:// URL. */
export const codexDesktopService = {
  async open(target: CodexOpenTarget & { prompt?: string }): Promise<string> {
    if (!isTauriRuntime()) throw new Error("Opening Codex requires the desktop app");
    if (target.threadId !== undefined && !isCodexThreadId(target.threadId)) throw new Error("Invalid Codex thread ID");
    if (!target.threadId && !isLocalCodexPath(target.cwd)) throw new Error("Codex requires a local absolute project path");
    return invoke<string>("open_in_codex", { ...target });
  },
};
