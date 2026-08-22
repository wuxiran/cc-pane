// 阻断面板的「手动接管」出口。
//
// 自动认领被拦下之后，用户面对的曾经是一块**没有任何操作入口**的死面板——唯一的
// 逃生口藏在状态栏资源管理器里，卡在这里的人不会知道要去那儿点。本模块把同一件事
// 搬到出事的地方。
//
// 与自动路径的唯一区别是**跳过策略关**（`anchorless-session`：没有出生锚点的会话
// 按设计不自动接管）。身份与安全校验一个不少：`attachSessionToAnchor` 仍会核对同
// 布局、项目路径等价、目标格子未被占用、该 PTY 未在别处重复挂载。
//
// 「用户显式点击 ≠ 自动认领」——docs/61 立这条策略时就是这么划的线。
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { sessionRestoreService, terminalService } from "@/services";
import { usePanesStore } from "@/stores";
import type { TerminalRestoreBlockedReason } from "@/types";

export type ManualAdoptResult = "attached" | "not-found" | "claim-failed" | "attach-failed";

/**
 * 把一条仍存活的会话手动挂回它自己的锚点。
 *
 * 失败时会把刚拿到的写权限释放掉——留着一个既没挂上、又被本实例占着的会话，
 * 比没接管更糟。
 */
export async function adoptBlockedSession(sessionId: string): Promise<ManualAdoptResult> {
  let saved;
  try {
    saved = await sessionRestoreService.load();
  } catch {
    return "not-found";
  }
  const record = Array.isArray(saved)
    ? saved.find((item) => item.sessionId === sessionId)
    : undefined;
  if (!record) return "not-found";

  let granted = false;
  try {
    granted = await terminalService.adoptSession(sessionId);
  } catch {
    granted = false;
  }
  if (!granted) return "claim-failed";

  const attached = usePanesStore.getState().attachSessionToAnchor({
    sessionId,
    layoutId: record.layoutId,
    tabId: record.tabId,
    terminalPaneId: record.terminalPaneId,
    expectedProjectPath: record.projectPath,
  });
  if (!attached) {
    await terminalService.releaseSession(sessionId).catch(() => {
      // 释放失败只影响写租约，30 秒后自动过期，不值得把错误抛给用户。
    });
    return "attach-failed";
  }
  usePanesStore.getState().setSessionLeaseReadOnly(sessionId, false);
  return "attached";
}

/**
 * 会话仍活着、只是没能自动挂回来的阻断原因——这些都该给用户当场接管的机会。
 *
 * `claims-unsupported` 不在其列：那条路径的会话属于「daemon 不支持安全认领」，
 * 已有专门的冷恢复按钮（结束旧终端再重启）。
 */
const ADOPTABLE_REASONS: ReadonlySet<TerminalRestoreBlockedReason> = new Set([
  "anchorless-session",
  "identity-mismatch",
  "attach-rejected",
  "claim-conflict",
  "auto-adopt-disabled",
  "missing-provenance",
]);

export function useManualAdopt(
  reason: TerminalRestoreBlockedReason,
  sessionId: string | undefined,
  enabled: boolean,
) {
  const { t } = useTranslation("panes");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = enabled && Boolean(sessionId) && ADOPTABLE_REASONS.has(reason);

  const adopt = useCallback(async () => {
    if (!sessionId || running) return;
    setError(null);
    setRunning(true);
    try {
      const result = await adoptBlockedSession(sessionId);
      if (result !== "attached") setError(t(`manualAdopt.${result}`));
    } catch {
      setError(t("manualAdopt.attach-failed"));
    } finally {
      setRunning(false);
    }
  }, [sessionId, running, t]);

  return { available, running, error, adopt };
}
