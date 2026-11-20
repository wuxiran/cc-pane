// SSH 机器连通性探测结果的派生：系统标签、CC-Panes 相关菜单动作、限并发批量检测。
import type { SshCcPanesProbe, SshConnectivityResult } from "@/types";

export type ConnectivityState = null | "checking" | SshConnectivityResult;

/** 自动检测的并发上限：避免一进视图就同时打出一串 SSH 连接 */
export const AUTO_PROBE_CONCURRENCY = 2;

/** 一键部署只支持这些远端系统（Windows 主机部署会失败） */
const DEPLOYABLE_OS = new Set(["linux", "macos"]);

const OS_LABEL_KEYS = {
  linux: "machines.osLinux",
  macos: "machines.osMacos",
  windows: "machines.osWindows",
} as const;

export type OsLabelKey = (typeof OS_LABEL_KEYS)[keyof typeof OS_LABEL_KEYS];

function settledResult(state: ConnectivityState): SshConnectivityResult | null {
  return state && state !== "checking" ? state : null;
}

/** 已探测到的系统对应的 i18n key；未探测 / 未知系统返回 null */
export function osLabelKey(state: ConnectivityState): OsLabelKey | null {
  const os = settledResult(state)?.os?.toLowerCase();
  if (!os || !Object.prototype.hasOwnProperty.call(OS_LABEL_KEYS, os)) return null;
  return OS_LABEL_KEYS[os as keyof typeof OS_LABEL_KEYS];
}

/** 远端正在运行的 CC-Panes（仅在已有结果且连通时） */
export function detectedCcPanes(state: ConnectivityState): SshCcPanesProbe | null {
  const result = settledResult(state);
  return result?.reachable ? result.ccPanes ?? null : null;
}

export type MachineCcPanesAction =
  | { kind: "deploy" }
  | { kind: "connect"; ccPanes: SshCcPanesProbe }
  | null;

/**
 * 机器菜单里给哪个 CC-Panes 动作：
 * - 已挂设备：都不给（设备卡片自己有操作）
 * - 探测到对方在跑 CC-Panes：给「连接」
 * - 探测到 Linux / macOS 且没在跑：给「部署」
 * - Windows / 未知系统 / 未探测：都不给
 */
export function resolveMachineCcPanesAction(
  hasLinkedDevice: boolean,
  state: ConnectivityState,
): MachineCcPanesAction {
  if (hasLinkedDevice) return null;
  const ccPanes = detectedCcPanes(state);
  if (ccPanes) return { kind: "connect", ccPanes };
  const result = settledResult(state);
  const os = result?.reachable ? result.os?.toLowerCase() : undefined;
  return os && DEPLOYABLE_OS.has(os) ? { kind: "deploy" } : null;
}

/** 以固定并发跑完 `ids`；`shouldStop` 为真时不再领取新任务 */
export async function runWithConcurrency(
  ids: readonly string[],
  limit: number,
  task: (id: string) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !shouldStop()) {
      const id = ids[next]!;
      next += 1;
      await task(id);
    }
  };
  const workers = Array.from({ length: Math.min(limit, ids.length) }, worker);
  await Promise.all(workers);
}
