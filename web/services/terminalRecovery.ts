// 恢复读路径归一（M3b-3，.claude/plan-m3b-design.md §M3b-3）。
//
// 前端恢复消费方从此只有一个形状：`TerminalRecoverySnapshot`
// （photo 直写 + delta 过 renderTerminalData 的双管道拆分在
// terminalReplay/terminalResync 落地）。
//
// - Tauri：get_terminal_recovery_snapshot 命令（Rust 侧已内置旧 daemon
//   CHECKPOINT_UNSUPPORTED 回落，包成 checkpoint: null 纯 delta 形状）。
// - web：GET /api/sessions/{id}/recovery-snapshot。404/405 分级判定口径照
//   daemon_client.rs::get_session_recovery_snapshot：结构化 NOT_FOUND = 会话
//   真没了（null）；无结构化 code = 旧 daemon 缺路由 → capability 关断 +
//   回落旧 /snapshot 包成同一形状（endSeq/epoch 置 0 = 无 seq 记账能力）。
// - 成功拿到 epoch≠0 时 noteEpoch——checkpoint 上传链路（M3b-2 落地时因
//   前端拿不到 epoch 而全 dormant）从此转活。
//
// 独立于 terminalService 的模块（该文件贴着行数棘轮基线，先例见
// terminalCheckpoint.ts）。
import type { TerminalRecoverySnapshot } from "@/types";
import { noteEpoch } from "@/components/panes/terminalOutputSeqTracker";
import { invokeOrApi } from "./apiClient";
import { terminalService } from "./terminalService";
import { debugTerminalService } from "./terminalServiceShared";

/** 首个缺路由后关断：旧 daemon 不会中途长出新端点，别再重复探测。 */
let recoveryCapabilityDisabled = false;

/** 旧端点回落：拼接快照包成统一形状（前端消费方只有一个形状）。 */
async function legacyRecoverySnapshot(
  sessionId: string,
): Promise<TerminalRecoverySnapshot | null> {
  const snapshot = await terminalService.getReplaySnapshot(sessionId);
  if (!snapshot) return null;
  return {
    checkpoint: null,
    delta: snapshot.data,
    bufferMode: snapshot.bufferMode,
    endSeq: 0,
    checkpointEpoch: 0,
  };
}

/**
 * web 直连模式。不走 apiGet——404 要按结构化 code 分级（会话真没了 vs
 * 旧 daemon 缺路由），泛化的 throw 会把两者揉成一个错误。
 */
async function fetchRecoverySnapshotViaApi(
  sessionId: string,
): Promise<TerminalRecoverySnapshot | null> {
  if (recoveryCapabilityDisabled) return legacyRecoverySnapshot(sessionId);
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/recovery-snapshot`,
  );
  if (response.ok) {
    return (await response.json()) as TerminalRecoverySnapshot;
  }
  const body = await response.text();
  let code: string | null = null;
  try {
    code = (JSON.parse(body) as { code?: string }).code ?? null;
  } catch {
    // 非 JSON body（如旧 daemon 的纯文本 404 页）
  }
  if (response.status === 404 || response.status === 405) {
    if (code === "NOT_FOUND") {
      // 新 daemon 的会话不存在（与旧 daemon 缺路由区分开）。
      return null;
    }
    recoveryCapabilityDisabled = true;
    debugTerminalService("recovery.capability.disabled", { sessionId });
    return legacyRecoverySnapshot(sessionId);
  }
  throw new Error(body || `HTTP ${response.status}: recovery snapshot failed`);
}

/**
 * checkpoint+delta 结构化恢复快照（读路径唯一入口）。
 * 会话不存在返回 null；旧后端自动回落成 checkpoint: null 纯 delta 形状。
 */
export async function getRecoverySnapshot(
  sessionId: string,
): Promise<TerminalRecoverySnapshot | null> {
  const snapshot = await invokeOrApi<TerminalRecoverySnapshot | null>(
    "get_terminal_recovery_snapshot",
    { sessionId },
    () => fetchRecoverySnapshotViaApi(sessionId),
  );
  if (!snapshot) return null;
  // epoch=0 = 旧 daemon 回落 / 无 seq 记账：不登记 epoch，上传保持 dormant。
  if (snapshot.checkpointEpoch !== 0) {
    noteEpoch(sessionId, snapshot.checkpointEpoch);
  }
  return snapshot;
}

/** 测试用：恢复 capability 探测状态。 */
export function _resetRecoveryCapabilityForTest(): void {
  recoveryCapabilityDisabled = false;
}
