import type { TerminalPaneLeaf } from "@/types";

/**
 * 终端 leaf 的恢复形态判定（纯函数，无 store 依赖）。
 *
 * 从 usePanesStore 抽出：同一段三元嵌套原本在建 tab / 克隆 leaf / 补 fallback leaf /
 * 快照迁移四处各写一遍，任何一处漏改都会让恢复告警口径不一致（docs/69 那类"看着像
 * 功能还在、其实没数据"的静默偏差）。
 */

export type TerminalRestoreMode = NonNullable<TerminalPaneLeaf["restoreMode"]>;

/** cliTool 缺省时回退到旧的 launchClaude / resumeId 推断。 */
export function inferCliTool(
  cliTool: string | undefined,
  ...claudeHints: unknown[]
): string {
  return cliTool ?? (claudeHints.some(Boolean) ? "claude" : "none");
}

export interface RestoreModeInput {
  cliTool: string;
  resumeId?: string;
  /** 有真身可接管（sessionId / savedSessionId / restoring）时直接算 resumed。 */
  hasRestorableSession?: boolean;
}

/**
 * 纯 shell 没有 resume 语义 → `shell`；能接上原会话或带真实 resumeId → `resumed`；
 * 其余是全新启动 → `fresh`。`"new"` 是"显式开新会话"的哨兵值，不算 resume。
 */
export function resolveRestoreMode(input: RestoreModeInput): TerminalRestoreMode {
  const { cliTool, resumeId, hasRestorableSession } = input;
  if (cliTool === "none") return "shell";
  if (hasRestorableSession) return "resumed";
  return resumeId && resumeId !== "new" ? "resumed" : "fresh";
}
