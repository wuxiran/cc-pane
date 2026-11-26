// 「重启并续接」Claude 会话：用 rec 切换账号后，已在跑的会话仍挂在旧账号的
// CLAUDE_CONFIG_DIR 上。这里把它们原地关掉重开（rec 启动时重新读当前账号），
// 并先让后端把 transcript 复制到当前账号目录，使 `--resume <id>` 能续上原对话。
import "@/i18n/tabContextMenuResources";
import i18n from "@/i18n";
import { toastInfo, toastOk, toastWarn } from "@/lib/feedback";
import { terminalService } from "@/services";
import { apiJson, invokeOrApi } from "@/services/apiClient";
import { nativeConfirm } from "@/services/nativeDialog";
import { usePanesStore } from "@/stores";
import type { TerminalRelaunchTarget } from "@/stores/panesStoreTypes";
import { writeTerminalRestoreLog as writeRestoreLog } from "@/stores/useTerminalRestoreLogStore";

type MigrationStatus = "copied" | "alreadyPresent" | "notFound" | "invalidId" | "failed";

interface PrepareClaudeRelaunchResult {
  accountId?: string | null;
  results: Array<{ resumeId: string; status: MigrationStatus; error?: string }>;
}

export interface RelaunchSummary {
  accountId: string | null;
  relaunched: number;
  failed: number;
  migrated: number;
  /** 没有 resumeId 或找不到 transcript：重启后是新对话。 */
  fresh: number;
}

function prepareClaudeRelaunch(resumeIds: string[]): Promise<PrepareClaudeRelaunchResult> {
  return invokeOrApi<PrepareClaudeRelaunchResult>("prepare_claude_relaunch", { resumeIds }, () =>
    apiJson<PrepareClaudeRelaunchResult>("/api/sessions/prepare-claude-relaunch", "POST", {
      resumeIds,
    }),
  );
}

async function relaunchOne(target: TerminalRelaunchTarget): Promise<boolean> {
  const panes = usePanesStore.getState();
  const { tabId, terminalPaneId, sessionId } = target;
  const previousSessionId = panes.beginTerminalRelaunch(tabId, terminalPaneId, sessionId);
  if (!previousSessionId) return false;
  writeRestoreLog(tabId, terminalPaneId, "relaunch.kill.begin", { sessionId: previousSessionId });
  try {
    await terminalService.killSession(previousSessionId, "relaunch");
  } catch (error) {
    panes.finishTerminalRelaunch(tabId, terminalPaneId, previousSessionId, false);
    writeRestoreLog(tabId, terminalPaneId, "relaunch.kill.failed", {
      sessionId: previousSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  panes.finishTerminalRelaunch(tabId, terminalPaneId, previousSessionId, true);
  writeRestoreLog(tabId, terminalPaneId, "relaunch.kill.end", { sessionId: previousSessionId });
  return true;
}

/** 重启给定的 Claude 会话（先迁移 transcript，再逐个原地重开）。 */
export async function relaunchClaudeTerminals(
  targets: TerminalRelaunchTarget[],
): Promise<RelaunchSummary> {
  const resumeIds = [...new Set(targets.map((t) => t.resumeId).filter((id): id is string => !!id))];
  let prepared: PrepareClaudeRelaunchResult = { accountId: null, results: [] };
  if (resumeIds.length > 0) {
    try {
      prepared = await prepareClaudeRelaunch(resumeIds);
    } catch (error) {
      // 迁移失败不阻断重启：最坏是新账号下续不上、开新对话。
      console.warn("[relaunch] prepare_claude_relaunch failed", error);
    }
  }
  const statusById = new Map(prepared.results.map((r) => [r.resumeId, r.status]));
  const summary: RelaunchSummary = {
    accountId: prepared.accountId ?? null,
    relaunched: 0,
    failed: 0,
    migrated: prepared.results.filter((r) => r.status === "copied").length,
    fresh: 0,
  };
  for (const target of targets) {
    const status = target.resumeId ? statusById.get(target.resumeId) : undefined;
    const willBeFresh = !target.resumeId
      || status === "notFound"
      || status === "invalidId"
      || status === "failed";
    if (await relaunchOne(target)) {
      summary.relaunched += 1;
      if (willBeFresh) summary.fresh += 1;
    } else {
      summary.failed += 1;
    }
  }
  return summary;
}

function confirmRelaunch(count: number): Promise<boolean> {
  const message = i18n.t("relaunchClaudeConfirmBody", { ns: "panes", count });
  const title = i18n.t("relaunchClaudeConfirmTitle", { ns: "panes" });
  return nativeConfirm(message, { title, kind: "warning" });
}

function notifySummary(summary: RelaunchSummary): void {
  const text = i18n.t("relaunchClaudeSummary", {
    ns: "panes",
    relaunched: summary.relaunched,
    migrated: summary.migrated,
    account: summary.accountId ?? "-",
  });
  const extra = [
    summary.fresh > 0 ? i18n.t("relaunchClaudeFresh", { ns: "panes", count: summary.fresh }) : "",
    summary.failed > 0 ? i18n.t("relaunchClaudeFailed", { ns: "panes", count: summary.failed }) : "",
  ].filter(Boolean).join("；");
  if (summary.failed > 0) toastWarn(text, { description: extra });
  else toastOk(text, extra ? { description: extra } : undefined);
}

/**
 * 入口：确认后重启全部（或指定标签内）的本机 Claude 会话。
 * 传 tabId 只处理该标签；不传处理所有布局（星标镜像不重复）。
 */
export async function confirmAndRelaunchClaudeTerminals(options?: { tabId?: string }): Promise<void> {
  const targets = usePanesStore.getState().collectClaudeRelaunchTargets(options);
  if (targets.length === 0) {
    toastInfo(i18n.t("relaunchClaudeNone", { ns: "panes" }));
    return;
  }
  if (!(await confirmRelaunch(targets.length))) return;
  notifySummary(await relaunchClaudeTerminals(targets));
}
