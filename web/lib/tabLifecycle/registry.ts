// Tab 生命周期登记表（docs/78 批1 · B1-01）。
//
// 每种 contentType 在这里声明「关闭一个 tab 要收什么尸 / 要不要拦 / 收完还要清什么」。
// 回收只依赖 tab 数据本身——组件从未挂载（快照覆盖、后台布局删除）时也必须能走通，
// 这正是现在 5 份散落 kill 实现漏杀的死因（docs/78 §0.2）。
//
// 范式与 `web/lib/tabContentType.ts` 相同：穷举登记 + 穷举测试。新增 contentType
// 时必须同步本表，`registry.test.ts` 会穷举断言（连同 paneSessions 的分桶键集）。
//
// 与销毁管线（./destroyPipeline.ts）的分工：
// - collectResources：供管线阶段 1/2/3 聚合（detach 全部 → kill 全部 → 关弹出窗口）。
// - closeGuards：供 planTabDestroy 聚合确认项（vetoable 的 reason 才消费）。
// - onClosed：管线阶段 4 的 per-tab 附属状态清理。**kill 不在这里**——kill 属于管线
//   阶段 2：批量销毁必须「先全部 detach 再 kill」（防杀 A 时 B 的 exit 回流），且 kill
//   在关弹出窗口**之前**、onClosed 在其后；若 onClosed 再 kill 一次，既破坏全局顺序
//   又让「killSession 调用集合精确相等」的测试口径失真。opts.detach 供非管线调用方
//   （管线阶段 1 已 detach，传 false）。
import { collectTerminalSessionIdsWithSaved } from "@/lib/paneSessions";
import type { TabContentType } from "@/lib/tabContentType";
import { browserService } from "@/services/browserService";
import { isTauriRuntime } from "@/services/runtime";
import { terminalService } from "@/services/terminalService";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import type { Tab, TerminalStatusType } from "@/types";
import type { DestroyReason } from "./destroyPipeline";

/** 一个 tab 关闭时需要回收的后端资源清单。 */
export interface TabResources {
  /** 归属该 tab 的全部 PTY 会话（分屏全量 + savedSessionId，见 collectTerminalSessionIdsWithSaved）。 */
  sessionIds: string[];
  /** 已弹出为独立系统窗口的 tabId（弹出窗口回收在管线阶段 3）。 */
  poppedOutTabIds: string[];
}

/**
 * 关闭确认项。planTabDestroy 聚合后交由 UI 弹确认；[] = 放行。
 * `agent-busy` 分支本轮已定义但**不发射**（B1-06 才启用，绞杀者纪律：先等价迁移再增强）。
 */
export type CloseGuard =
  | {
      kind: "agent-busy";
      tabId: string;
      tabTitle: string;
      sessionId: string;
      status: TerminalStatusType;
    }
  | { kind: "editor-dirty"; tabId: string; tabTitle: string };

/**
 * 守卫/资源判定所需的外部状态，注入而不直读 store——planTabDestroy 保持纯函数可测。
 * 生产侧默认实现见 destroyPipeline 的 liveGuardContext()。
 */
export interface GuardContext {
  statusOf(sessionId: string): TerminalStatusType | null;
  isPoppedOut(tabId: string): boolean;
}

/** onClosed 的调用参数。管线阶段 4 传 { detach: false }（阶段 1 已全量 detach）。 */
export interface TabDestroyOptions {
  detach: boolean;
  reason: DestroyReason;
}

export interface TabLifecycleEntry {
  collectResources(tab: Tab, ctx: GuardContext): TabResources;
  closeGuards(tab: Tab, ctx: GuardContext): CloseGuard[];
  onClosed(tab: Tab, opts: TabDestroyOptions): void;
}

/** 弹出窗口判定进 collectResources（docs/78 批1 风险注：防「漏杀修成多杀」的同族漏收）。 */
function collectPoppedOut(tab: Tab, ctx: GuardContext): string[] {
  return ctx.isPoppedOut(tab.id) ? [tab.id] : [];
}

const terminalEntry: TabLifecycleEntry = {
  collectResources: (tab, ctx) => ({
    // savedSessionId 必须并入：restoring 中尚未 attach 的 savedSessionId 是真实 PTY，
    // 漏掉即成孤儿（轨 C 的新口径，旧口径 collectTerminalSessionIds 保持原样另有消费者）。
    sessionIds: collectTerminalSessionIdsWithSaved(tab),
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  // B1-06 前恒放行：agent-busy guard 的类型已就位，但发射点留到确认弹窗接好之后
  // 再打开——先等价迁移现状（现状关终端 tab 不确认），再增强。届时用 ctx.statusOf。
  closeGuards: () => [],
  onClosed: (tab, opts) => {
    for (const sessionId of collectTerminalSessionIdsWithSaved(tab)) {
      if (opts.detach) {
        terminalService.detachOutput(sessionId);
        terminalService.detachExit(sessionId);
      }
      useTerminalStatusStore.getState().removeSession(sessionId);
      // useContextUsageStore 是单例（当前聚焦会话），不是 Record：
      // 只有被关会话恰是当前会话时才清。每轮重读 state，避免 setSession 后用陈旧快照。
      if (useContextUsageStore.getState().sessionId === sessionId) {
        useContextUsageStore.getState().setSession(null);
      }
    }
  },
};

const browserEntry: TabLifecycleEntry = {
  collectResources: (tab, ctx) => ({
    sessionIds: [],
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  closeGuards: () => [], // v1 不拦浏览器（docs/78 §2.2 关闭确认矩阵）
  onClosed: (tab) => {
    // 收编 webview 关闭：不再只靠 BrowserTabContent 的 React unmount 兜底——
    // 组件从未挂载的销毁路径（快照覆盖/后台布局删除）也要能关掉 webview 进程。
    // 后端对不存在的 webview 幂等，双重 close 无害。
    if (!isTauriRuntime()) return;
    void browserService.close(tab.id).catch((error) => {
      handleErrorSilent(error, "close browser webview");
    });
  },
};

const editorEntry: TabLifecycleEntry = {
  collectResources: (tab, ctx) => ({
    sessionIds: [],
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  // 承接现状语义：dirty 未保存 → 弹确认（pinned 保护不在这里，归 DESTROY_POLICY.respectsPinned）。
  closeGuards: (tab) =>
    tab.dirty ? [{ kind: "editor-dirty", tabId: tab.id, tabTitle: tab.title }] : [],
  onClosed: () => {},
};

/** 无后端资源、无守卫的显式 no-op 登记（工厂产实例，未来分化互不影响）。 */
function inertEntry(): TabLifecycleEntry {
  return {
    collectResources: (tab, ctx) => ({
      sessionIds: [],
      poppedOutTabIds: collectPoppedOut(tab, ctx),
    }),
    closeGuards: () => [],
    onClosed: () => {},
  };
}

/** 7 种 contentType 全登记。新增类型时 registry.test.ts 的穷举断言会逼着同步这里。 */
export const TAB_LIFECYCLE: Record<TabContentType, TabLifecycleEntry> = {
  terminal: terminalEntry,
  browser: browserEntry,
  editor: editorEntry,
  "file-explorer": inertEntry(),
  "mcp-config": inertEntry(),
  "skill-manager": inertEntry(),
  "memory-manager": inertEntry(),
};
