// Tab 销毁管线（docs/78）。
//
// 「谁负责收尸」的唯一答案：任何关 tab 的出口最终都经 planTabDestroy（纯函数，
// 收集资源 + 聚合确认项）与 commitResourceDestroy（固定四阶段副作用）。语义差异
// （可否决 / 记撤销 / pinned 保护 / 杀不杀 / 关不关弹窗）全部收进 DESTROY_POLICY
// 矩阵——散在 7 个出口里各自脑补正是漏杀孤儿 PTY 的死因（docs/78 §0.2）。
//
// 矩阵与 KillReason 映射由 destroyPipeline.test.ts 穷举锁死，改动先改测试。
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  getPoppedTabs,
  isTabPoppedOut,
  markTabReclaimed,
} from "@/services/popupWindowService";
import { isTauriRuntime } from "@/services/runtime";
import { terminalService } from "@/services/terminalService";
import { useTabAttentionStore } from "@/stores/useTabAttentionStore";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import type { KillReason, Tab } from "@/types";
import { TAB_LIFECYCLE } from "./registry";
import type { CloseGuard, GuardContext } from "./registry";

/**
 * 销毁来源。语义由 DESTROY_POLICY 矩阵声明，新增来源必须补齐矩阵两张表
 * （穷举测试会逼着同步）。
 */
export type DestroyReason =
  | "user-close"
  | "batch-close"
  | "close-pane"
  | "delete-layout"
  | "snapshot-apply"
  | "backend-close"
  | "editor-path-close";

/** DestroyReason 全集（穷举测试与消费方遍历用）。 */
export const ALL_DESTROY_REASONS: readonly DestroyReason[] = [
  "user-close",
  "batch-close",
  "close-pane",
  "delete-layout",
  "snapshot-apply",
  "backend-close",
  "editor-path-close",
] as const;

export interface DestroyPolicy {
  /** 是否允许 closeGuards 否决（弹确认）。自动化路径必须为 false，否则无人值守流程被卡死。 */
  vetoable: boolean;
  /** 是否记入 closedTabs 供「重新打开已关闭的标签」撤销。 */
  recordsClosedTabs: boolean;
  /** 是否跳过 pinned tab。 */
  respectsPinned: boolean;
  /** 是否 kill PTY 会话。false = 会话已由后端杀掉或明确不归本路径管。 */
  kills: boolean;
  /** 是否回收已弹出的独立窗口。 */
  closesPopups: boolean;
}

/**
 * 语义矩阵（docs/78；逐格锁定，勿按直觉改）：
 * - backend-close：session-killed 事件驱动，后端已经杀了，再 kill 是重杀 → kills=false。
 * - editor-path-close：closeEditorTabsByPath 只针对 editor tab，无 PTY 可杀，
 *   也不关弹窗（editor 不弹出）→ 两者皆 false。
 * - snapshot-apply/backend-close/editor-path-close 不可否决但**绝不跳过回收**。
 */
export const DESTROY_POLICY: Record<DestroyReason, DestroyPolicy> = {
  "user-close": {
    vetoable: true,
    recordsClosedTabs: true,
    respectsPinned: true,
    kills: true,
    closesPopups: true,
  },
  "batch-close": {
    vetoable: true,
    recordsClosedTabs: true,
    respectsPinned: true,
    kills: true,
    closesPopups: true,
  },
  "close-pane": {
    vetoable: true,
    recordsClosedTabs: true,
    respectsPinned: false,
    kills: true,
    closesPopups: true,
  },
  "delete-layout": {
    vetoable: true,
    recordsClosedTabs: false,
    respectsPinned: false,
    kills: true,
    closesPopups: true,
  },
  "snapshot-apply": {
    vetoable: false,
    recordsClosedTabs: false,
    respectsPinned: false,
    kills: true,
    closesPopups: true,
  },
  "backend-close": {
    vetoable: false,
    recordsClosedTabs: false,
    respectsPinned: false,
    kills: false,
    closesPopups: true,
  },
  "editor-path-close": {
    vetoable: false,
    recordsClosedTabs: false,
    respectsPinned: false,
    kills: false,
    closesPopups: false,
  },
};

/**
 * DestroyReason → killSession 的 reason 标注。
 * kills=false 的 reason 映射 null（commit 阶段 2 整步跳过，测试锁「零 killSession 调用」）。
 *
 * **绝不允许映射进回收类**（orphan-reclaim / daemon-reaper / launch-timeout）：
 * terminalService 的 session-killed 监听按 isTerminalReclaimKillReason 分流，回收类
 * 走「保留标签显示退出」——前端主动关标签若标成回收类，标签就关不掉了。
 * destroyPipeline.test.ts 与 isTerminalReclaimKillReason 双向锁死此约束。
 */
export const DESTROY_KILL_REASON: Record<DestroyReason, KillReason | null> = {
  "user-close": "user-close",
  "batch-close": "user-close",
  "close-pane": "user-close",
  "delete-layout": "user-close",
  "snapshot-apply": "user-close",
  "backend-close": null,
  "editor-path-close": null,
};

export interface DestroyPlan {
  reason: DestroyReason;
  policy: DestroyPolicy;
  /** pinned 过滤后真正要销毁的 tab。 */
  tabs: Tab[];
  /** respectsPinned=true 时被豁免的 pinned tab。 */
  skippedPinnedTabIds: string[];
  /** 去重后的全量会话（含 savedSessionId 口径）。 */
  sessionIds: string[];
  /** 去重后的已弹出窗口 tabId。 */
  poppedOutTabIds: string[];
  /** vetoable=true 时聚合的确认项；[] = 放行。非 vetoable 恒为 []。 */
  guards: CloseGuard[];
}

/** 生产侧 GuardContext：从真实 store / service 读。测试注入假 ctx 保持 plan 纯函数可测。 */
export function liveGuardContext(): GuardContext {
  return {
    statusOf: (sessionId) => useTerminalStatusStore.getState().getStatus(sessionId),
    isPoppedOut: (tabId) => isTabPoppedOut(tabId),
  };
}

/**
 * 纯函数：按登记表收集资源 + 聚合确认项。不产生任何副作用。
 * 调用方拿到 plan 后：guards 非空 → 弹确认；确认/放行 → commitResourceDestroy + 树操作。
 */
export function planTabDestroy(
  tabs: readonly Tab[],
  reason: DestroyReason,
  ctx: GuardContext,
): DestroyPlan {
  const policy = DESTROY_POLICY[reason];
  const included: Tab[] = [];
  const skippedPinnedTabIds: string[] = [];
  for (const tab of tabs) {
    if (policy.respectsPinned && tab.pinned) {
      skippedPinnedTabIds.push(tab.id);
    } else {
      included.push(tab);
    }
  }

  const sessionIds = new Set<string>();
  const poppedOutTabIds = new Set<string>();
  const guards: CloseGuard[] = [];
  for (const tab of included) {
    const entry = TAB_LIFECYCLE[tab.contentType];
    const resources = entry.collectResources(tab, ctx);
    for (const sessionId of resources.sessionIds) sessionIds.add(sessionId);
    for (const tabId of resources.poppedOutTabIds) poppedOutTabIds.add(tabId);
    if (policy.vetoable) guards.push(...entry.closeGuards(tab, ctx));
  }

  return {
    reason,
    policy,
    tabs: included,
    skippedPinnedTabIds,
    sessionIds: [...sessionIds],
    poppedOutTabIds: [...poppedOutTabIds],
    guards,
  };
}

/**
 * owner(tabId) 键卫星态的统一清扫：视图聚合 + 注意标记。
 *
 * 销毁侧卫星态清理只有两个归属点，新增卫星 store 时先归类，不要在出口各自脑补：
 * - **会话键**状态（status / contextUsage / 输入活跃）在 registry 的 terminal
 *   onClosed 清——它们随 PTY 会话生灭；
 * - **owner 键**状态（视图聚合 / 注意标记）在树操作出口清（removeTabsInternal /
 *   closeTabBySessionId / deleteLayout）——它们随标签生灭，且只有树操作知道
 *   标签是否真的从所有布局消失（星标镜像同 id 仍在别的布局时不能清）。
 */
export function sweepOwnerState(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    useTabViewStateStore.getState().removeOwner(tabId);
    useTabAttentionStore.getState().clearAttention(tabId);
  }
}

/**
 * 关闭已弹出的独立窗口。语义搬自 LayoutDeleteDialog：**两份真相都要回收**——
 * WebviewWindow 本体 close + popupWindowService.markTabReclaimed。
 * store 侧 poppedOutTabs Set 由 removeTabsInternal 清（树操作职责），本函数不碰。
 */
async function closePoppedWindows(tabIds: string[]): Promise<void> {
  if (!isTauriRuntime()) return;
  const poppedTabs = getPoppedTabs();
  await Promise.all(
    tabIds.map(async (tabId) => {
      const label = poppedTabs.get(tabId);
      if (!label) return;
      try {
        const win = await WebviewWindow.getByLabel(label);
        await win?.close();
        markTabReclaimed(tabId);
      } catch (error) {
        handleErrorSilent(error, "close popup window");
      }
    }),
  );
}

/**
 * 资源销毁提交：固定四阶段，**顺序不可变**（LayoutDeleteDialog.test.tsx 曾锁死等价顺序）：
 * 1. detach 全部会话（先全部解绑再杀——杀 A 时 B 的 exit 事件不得回流到已注销视图）；
 * 2. kill 全部（扣除 opts.protectSessionIds；policy.kills=false 整步跳过）；
 * 3. 关弹出窗口（policy.closesPopups=true 时）；
 * 4. per-tab onClosed 附属状态清理（detach: false——阶段 1 已做）。
 *
 * 只管资源，不做树操作：从布局树移除 tab 归 removeTabsInternal，两者由
 * 各出口按「先 commit 再移树」顺序编排。单个 kill/close 失败不中断整条管线。
 */
export async function commitResourceDestroy(
  tabs: readonly Tab[],
  reason: DestroyReason,
  opts: { protectSessionIds?: ReadonlySet<string> } = {},
): Promise<void> {
  const plan = planTabDestroy(tabs, reason, liveGuardContext());

  await destroySessionsDirectly(plan.sessionIds, plan.poppedOutTabIds, reason, opts);

  // 阶段 4：per-tab 附属状态清理
  for (const tab of plan.tabs) {
    TAB_LIFECYCLE[tab.contentType].onClosed(tab, { detach: false, reason });
  }
}

/**
 * 资源回收的前三阶段（detach → kill → 关弹窗），按**会话 id 集合**驱动。
 *
 * 给「手里只有 id、没有 Tab 」的调用方用：整层删除的 summary 是打开对话框
 * 那一刻算好的，用户看到的数字就是它——重新遍历树去反推 tab 会与展示脱节
 * （树在对话框打开期间可能已经变了）。
 *
 * 阶段顺序不可变：先把**全部**会话 detach 完再开始 kill，否则杀 A 的等待
 * 期间 B 的 exit 事件会回流到正在销毁的视图。
 */
export async function destroySessionsDirectly(
  sessionIds: readonly string[],
  poppedOutTabIds: readonly string[],
  reason: DestroyReason,
  opts: { protectSessionIds?: ReadonlySet<string> } = {},
): Promise<void> {
  const policy = DESTROY_POLICY[reason];

  // 阶段 1：detach 全部
  for (const sessionId of sessionIds) {
    terminalService.detachOutput(sessionId);
    terminalService.detachExit(sessionId);
  }

  // 阶段 2：kill 全部（扣保护名单）
  if (policy.kills) {
    const killReason = DESTROY_KILL_REASON[reason] ?? undefined;
    await Promise.all(
      sessionIds
        .filter((sessionId) => !opts.protectSessionIds?.has(sessionId))
        .map((sessionId) =>
          terminalService.killSession(sessionId, killReason).catch((error) => {
            handleErrorSilent(error, "kill tab session");
          }),
        ),
    );
  }

  // 阶段 3：关弹出窗口
  if (policy.closesPopups) {
    await closePoppedWindows([...poppedOutTabIds]);
  }
}
