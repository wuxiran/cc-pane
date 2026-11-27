// 「抢回写权限」：把被另一个 CC-Panes 实例持有的终端写租约拿回本实例。
//
// 两步走：先做一次**普通认领**（`adoptSession`）——对侧实例已崩溃/已退出时租约
// 30 秒内过期，普通认领即可拿回，不必惊动任何人；普通认领被拒（对侧仍在续租）
// 才走**强制抢占**（`forceAdoptSession`）。对侧在下次续约时拿到 409，会经
// `terminal-claim-lost` 自行降为只读——这正是 daemon 续租线程「不重试抢占」的既有语义。
//
// 入口（标签右键 / 终端区右键 / 只读横幅按钮）只调用 `requestLeaseReclaim`，
// 真正的确认与执行集中在全局挂载的 `LeaseReclaimDialog`：强制抢占会让另一个实例
// 变只读，必须先让用户确认（「用户显式点击 ≠ 自动认领」，docs/61）。
import { create } from "zustand";
import { collectTerminalLeaves } from "@/lib/paneTree";
import { terminalService } from "@/services";
import { usePanesStore } from "@/stores";
import type { Tab } from "@/types";

export type LeaseReclaimResult =
  /** 已拿到写权限，本实例终端恢复可写。 */
  | "reclaimed"
  /** 强制抢占仍被拒（对侧在抢占瞬间续租成功，或会话已不存在）。 */
  | "held-by-other"
  /** 后端尚未提供强制抢占接口（`force_adopt_terminal_session` 未注册）。 */
  | "force-unsupported"
  /** IPC/网络等其它失败。 */
  | "failed";

const FORCE_COMMAND = "force_adopt_terminal_session";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

/** Tauri 对未注册命令的拒绝形如 `command force_adopt_terminal_session not found`。 */
export function isForceAdoptUnsupported(error: unknown): boolean {
  const text = errorText(error);
  return text.includes(FORCE_COMMAND) && /not found/i.test(text);
}

async function tryNormalAdopt(sessionId: string): Promise<boolean> {
  try {
    return await terminalService.adoptSession(sessionId);
  } catch {
    // 普通认领失败不终止流程：强制抢占一步会给出可见的结论。
    return false;
  }
}

/** 执行抢回；成功时同步把本实例所有引用该会话的 leaf 置回可写。 */
export async function reclaimSessionLease(sessionId: string): Promise<LeaseReclaimResult> {
  let granted = await tryNormalAdopt(sessionId);
  if (!granted) {
    try {
      granted = await terminalService.forceAdoptSession(sessionId);
    } catch (error) {
      if (isForceAdoptUnsupported(error)) return "force-unsupported";
      console.warn("[lease-reclaim] force adopt failed", { sessionId, error: errorText(error) });
      return "failed";
    }
  }
  if (!granted) return "held-by-other";
  usePanesStore.getState().setSessionLeaseReadOnly(sessionId, false);
  return "reclaimed";
}

interface LeaseReclaimState {
  /** 待确认抢回的会话；null = 对话框关闭。 */
  sessionId: string | null;
  request: (sessionId: string) => void;
  close: () => void;
}

export const useLeaseReclaimStore = create<LeaseReclaimState>()((set) => ({
  sessionId: null,
  request: (sessionId) => set({ sessionId }),
  close: () => set({ sessionId: null }),
}));

/** 各入口统一调用：打开确认对话框。 */
export function requestLeaseReclaim(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  useLeaseReclaimStore.getState().request(sessionId);
}

/**
 * 标签右键菜单用：找出该终端标签里处于「租约只读」的会话。
 * 优先当前激活的分屏格子，其次第一个只读格子；没有则返回 null（菜单项不显示）。
 */
export function findLeaseReadOnlySessionId(tab: Tab): string | null {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) return null;
  const readOnly = collectTerminalLeaves(tab.terminalRootPane)
    .filter((leaf) => leaf.leaseReadOnly && leaf.sessionId);
  const active = readOnly.find((leaf) => leaf.id === tab.activeTerminalPaneId);
  return (active ?? readOnly[0])?.sessionId ?? null;
}
