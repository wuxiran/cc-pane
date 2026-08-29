// Tab 生命周期登记表（docs/78）。
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
import { isBusyStatus } from "@/types/settings";
import { browserService } from "@/services/browserService";
// 直接 import 具体模块而非桶文件：destroyPipeline 的测试 mock 的是具体模块，
// 走桶文件会绕过 mock，表现成「回收没发生」（CLAUDE.md 已记这条坑）。
import { agentChatService } from "@/services/agentChatService";
import { dropAgentChatState } from "@/stores/useAgentChatStore";
import { dshService } from "@/services/dshService";
import { isTauriRuntime } from "@/services/runtime";
import { terminalService } from "@/services/terminalService";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { useTerminalInputActivityStore } from "@/stores/useTerminalInputActivityStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import type { Tab, TerminalStatusType } from "@/types";
import type { DestroyReason } from "./destroyPipeline";
import type { TabCreateInput } from "./tabFactory";
import {
  clearTabViewState,
  readTabViewState,
  reportTabViewState,
  type TabViewState,
} from "./tabViewState";
import { terminalTabDefaults } from "./terminalTabDefaults";

/** 一个 tab 关闭时需要回收的后端资源清单。 */
export interface TabResources {
  /** 归属该 tab 的全部 PTY 会话（分屏全量 + savedSessionId，见 collectTerminalSessionIdsWithSaved）。 */
  sessionIds: string[];
  /** 已弹出为独立系统窗口的 tabId（弹出窗口回收在管线阶段 3）。 */
  poppedOutTabIds: string[];
}

/**
 * 关闭确认项。planTabDestroy 聚合后交由 UI 弹确认；[] = 放行。
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
  /**
   * 该类型的构造默认值（docs/78 批4）。只产字段，不落位——唯一消费点是
   * `./tabFactory.ts` 的 createTabOfType，公共底座字段（id、contentType、
   * projectId、projectPath、sessionId）由它给，这里只补类型特有的部分。
   */
  createDefaults(input: TabCreateInput): Partial<Tab>;
  collectResources(tab: Tab, ctx: GuardContext): TabResources;
  closeGuards(tab: Tab, ctx: GuardContext): CloseGuard[];
  onClosed(tab: Tab, opts: TabDestroyOptions): void;
  /**
   * 关闭时要进撤销栈的快照；null = 本类型不可撤销（docs/78）。
   * terminal 不走这里（launch 身份字段多，专用映射在 closedTabsUndo）。
   */
  persistForUndo?(tab: Tab): PersistedUndoSnapshot | null;
  /**
   * 关闭时取走组件级视图状态（docs/78 批4 的 onPersist）。
   *
   * 与 persistForUndo 的分工：那个存**标签数据**（filePath / URL——组件没挂载
   * 也读得到），这个存**视图状态**（光标 / 滚动——只活在组件实例里）。后者由
   * 组件在活着时上报到 tabViewState，这里只是取走。
   */
  onPersist?(tab: Tab): TabViewState | undefined;
  /**
   * 重开时把视图状态还给组件（docs/78 批4 的 onRestoreState）。
   * 在新标签建好之后调用，`newTabId` 是新标签的 id。
   */
  onRestoreState?(newTabId: string, snapshot: PersistedUndoSnapshot): void;
}

/** persistForUndo 的产出（ClosedTabSnapshot 的非终端子集）。 */
export interface PersistedUndoSnapshot {
  contentType: "browser" | "editor";
  projectId: string;
  projectPath: string;
  title: string;
  browserUrl?: string;
  filePath?: string;
  /** 组件级视图状态（onPersist 产出，onRestoreState 消费）。 */
  viewState?: TabViewState;
}

/** 弹出窗口判定进 collectResources——防「漏杀修成多杀」的同族漏收（docs/78）。 */
function collectPoppedOut(tab: Tab, ctx: GuardContext): string[] {
  return ctx.isPoppedOut(tab.id) ? [tab.id] : [];
}

/**
 * 是不是 agent 会话（Claude/Codex/OpenCode 等），而不是裸 shell。
 *
 * 关闭确认只对 agent 生效：agent 里跑着的是一整段有价值的上下文，误关的代价
 * 是它整个消失；纯 shell 关掉重开即可。`launchClaude` 是老快照的遗留字段。
 */
function isAgentTab(tab: Tab): boolean {
  if (tab.launchClaude) return true;
  return Boolean(tab.cliTool && tab.cliTool !== "none");
}

const terminalEntry: TabLifecycleEntry = {
  // 无 terminal 入参时退化为「空壳终端标签」（createPanel 的占位形态）：
  // 仍建 leaf，projectPath 为空——没有 projectPath 的标签不会启动 PTY。
  createDefaults: (input) =>
    terminalTabDefaults(
      input.terminal ?? {
        projectId: input.projectId ?? "",
        projectPath: input.projectPath ?? "",
        customTitle: input.title,
      },
    ),
  collectResources: (tab, ctx) => ({
    // savedSessionId 必须并入：restoring 中尚未 attach 的 savedSessionId 是真实 PTY，
    // 漏掉即成孤儿。
    sessionIds: collectTerminalSessionIdsWithSaved(tab),
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  // agent 会话忙碌/等输入时挡一道确认。
  //
  // 三条判定要点：
  // 1. **只挡 agent，不挡纯 shell**——shell 的状态是 none 而非 idle，关一个 shell
  //    弹确认纯属骚扰（docs/78 §2.2 三轴模型：纯 shell 无「内容忙碌」轴）。
  // 2. `waitingInput` 必须显式并入——它不在 BUSY_STATUSES 里，但「等你回答」的
  //    会话被静默关掉，损失和忙碌时一样大。照抄 interruptGate.isAnySessionBusy
  //    的先例，不去改 BUSY_STATUSES 本体（打扰闸门等多处共用）。
  // 3. 分屏 tab 逐 leaf 判，任一 leaf 忙就挡——确认框会列出具体是哪个会话。
  closeGuards: (tab, ctx) => {
    const guards: CloseGuard[] = [];
    // dirty 是跨 contentType 的通用状态（改道前 useTabClosing 对所有 tab 无差别
    // 检查它）。终端 tab 也可能带 dirty——按 contentType 分派后若只在 editor
    // 登记，终端上的未保存确认就会静默消失。
    if (tab.dirty) {
      guards.push({ kind: "editor-dirty", tabId: tab.id, tabTitle: tab.title });
    }
    if (!isAgentTab(tab)) return guards;
    for (const sessionId of collectTerminalSessionIdsWithSaved(tab)) {
      const status = ctx.statusOf(sessionId);
      if (!status) continue;
      if (isBusyStatus(status) || status === "waitingInput") {
        guards.push({
          kind: "agent-busy",
          tabId: tab.id,
          tabTitle: tab.title,
          sessionId,
          status,
        });
      }
    }
    return guards;
  },
  onClosed: (tab, opts) => {
    for (const sessionId of collectTerminalSessionIdsWithSaved(tab)) {
      if (opts.detach) {
        terminalService.detachOutput(sessionId);
        terminalService.detachExit(sessionId);
      }
      // 会话键卫星态统一在这里清（status / contextUsage / 输入活跃）；
      // owner 键的（视图聚合 / 注意标记）归 destroyPipeline.sweepOwnerState。
      useTerminalStatusStore.getState().removeSession(sessionId);
      useTerminalInputActivityStore.getState().clearSession(sessionId);
      // per-session 上下文用量缓存条目随会话回收。exit 驱动的 dropSession
      // 对管线销毁不可达——阶段 1 已 detach exit 监听，事件到不了前端，
      // 条目原本只能等 64 上限硬淘汰。
      useContextUsageStore.getState().dropSession(sessionId);
      // useContextUsageStore 是单例（当前聚焦会话），不是 Record：
      // 只有被关会话恰是当前会话时才清。每轮重读 state，避免 setSession 后用陈旧快照。
      if (useContextUsageStore.getState().sessionId === sessionId) {
        useContextUsageStore.getState().setSession(null);
      }
    }
  },
};

const browserEntry: TabLifecycleEntry = {
  // 标题留空会让标签栏出现一个无名条目，故有兜底文案；URL 不兜底（无 URL 的
  // browser 标签渲染层直接 return null，兜一个假 URL 只会掩盖调用方的 bug）。
  createDefaults: (input) => ({
    title: input.title?.trim() || "Browser",
    browserUrl: input.browserUrl,
  }),
  collectResources: (tab, ctx) => ({
    sessionIds: [],
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  closeGuards: () => [], // v1 不拦浏览器（docs/78 §2.2 关闭确认矩阵）
  // browserUrl 是**导航后的实时值**：BrowserTabContent 的 onPageLoad 会把每次
  // 跳转写回 tab，所以撤销回到的是用户最后停留的页面，而不是当初打开的那个。
  //
  // 滚动位置**未覆盖**（docs/78 批4 偏差）：webview 是独立进程，读它的
  // scrollY 需要 CDP `Runtime.evaluate`——该能力在 Rust 侧存在
  // （browser_service.rs::evaluate）但没有注册成 command，前端够不着。
  // 补一条命令属于新增 IPC 面，不在本批范围；此处记录为已知缺口，
  // 免得后来者以为「存了 URL 就等于存了浏览位置」。
  persistForUndo: (tab) =>
    tab.browserUrl
      ? {
          contentType: "browser",
          projectId: tab.projectId,
          projectPath: tab.projectPath,
          title: tab.title,
          browserUrl: tab.browserUrl,
        }
      : null,
  onClosed: (tab) => {
    // 收编 webview 关闭：不再只靠 BrowserTabContent 的 React unmount 兜底——
    // 组件从未挂载的销毁路径（快照覆盖/后台布局删除）也要能关掉 webview 进程。
    // 后端对不存在的 webview 幂等，双重 close 无害。
    if (!isTauriRuntime()) return;
    // Promise.resolve 包一层：close 在 mock/降级环境可能返回 undefined，
    // 裸 .catch 会把「回收兜底」本身变成未处理异常。
    void Promise.resolve(browserService.close(tab.id)).catch((error) => {
      handleErrorSilent(error, "close browser webview");
    });
  },
};

const dshEntry: TabLifecycleEntry = {
  createDefaults: (input) => ({
    title: input.title?.trim() || "DeepSeek Harness",
    // browserUrl 由窗格在实例起来后回填（端口是 OS 分配的，创建标签时还不知道）。
    browserUrl: input.browserUrl,
    // 决定复用哪个 dsh 实例。丢了它，每个标签都会落到共享的 "default" 实例，
    // 工作空间级隔离就退化成「全都挤在一起」。
    workspacePath: input.workspacePath,
  }),
  collectResources: (tab, ctx) => ({
    // dsh 会话活在它自己的进程里，不占 CC-Panes 的 PTY——sessionIds 恒空。
    sessionIds: [],
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  closeGuards: () => [],
  // 不做撤销恢复：撤销会拿旧 URL 重开，而那个端口属于已经停掉的进程，
  // 恢复出来必然是一个连不上的页面。宁可不给撤销，也不给一个坏掉的标签。
  persistForUndo: () => null,
  onClosed: (tab) => {
    if (!isTauriRuntime()) return;
    // 两件事都要做，且都必须能在「组件从未挂载」的销毁路径上跑通
    // （快照覆盖 / 后台布局删除时窗格没渲染过）：
    //   1. 停 dsh 进程——不停就是每关一个标签泄漏一个 ~119MB 的 node 进程；
    //   2. 关 webview——与 browser 标签同理。
    // 后端对不存在的实例/webview 都幂等。
    void Promise.resolve(dshService.stop(tab.id)).catch((error) => {
      handleErrorSilent(error, "stop dsh instance");
    });
    void Promise.resolve(browserService.close(tab.id)).catch((error) => {
      handleErrorSilent(error, "close dsh webview");
    });
    clearTabViewState(tab.id);
  },
};

const agentChatEntry: TabLifecycleEntry = {
  createDefaults: (input) => ({
    title: input.title?.trim() || "Agent Chat",
  }),
  collectResources: (tab, ctx) => ({
    // ACP 会话是独立子进程，不占 CC-Panes 的 PTY——sessionIds 恒空。
    sessionIds: [],
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  // v1 不拦：generating 状态活在 useAgentChatStore，GuardContext 目前只有
  // PTY 会话口径。关闭确认属于批次 2（与会话持久化一起做）。
  closeGuards: () => [],
  // 不做撤销恢复：会话进程已随关闭停掉，重开只会得到一个空对话。
  persistForUndo: () => null,
  onClosed: (tab) => {
    // 渲染态（消息流 + chunk 缓冲）无论运行时都要回收，否则关一个标签漏一份。
    dropAgentChatState(tab.id);
    clearTabViewState(tab.id);
    if (!isTauriRuntime()) return;
    // 必须能在「组件从未挂载」的销毁路径上跑通（快照覆盖/后台布局删除）：
    // 不停进程就是每关一个标签泄漏一个 adapter+CLI 进程树。后端幂等。
    void Promise.resolve(agentChatService.stop(tab.id)).catch((error) => {
      handleErrorSilent(error, "stop acp chat session");
    });
  },
};

const editorEntry: TabLifecycleEntry = {
  createDefaults: (input) => ({ filePath: input.filePath }),
  collectResources: (tab, ctx) => ({
    sessionIds: [],
    poppedOutTabIds: collectPoppedOut(tab, ctx),
  }),
  // 承接现状语义：dirty 未保存 → 弹确认（pinned 保护不在这里，归 DESTROY_POLICY.respectsPinned）。
  closeGuards: (tab) =>
    tab.dirty ? [{ kind: "editor-dirty", tabId: tab.id, tabTitle: tab.title }] : [],
  onClosed: (tab) => {
    // 视图状态随标签回收——不清则 Map 随开关标签无限增长。
    clearTabViewState(tab.id);
  },
  persistForUndo: (tab) =>
    tab.filePath && tab.projectPath
      ? {
          contentType: "editor",
          projectId: tab.projectId,
          projectPath: tab.projectPath,
          title: tab.title,
          filePath: tab.filePath,
          viewState: editorEntry.onPersist?.(tab),
        }
      : null,
  onPersist: (tab) => readTabViewState(tab.id),
  // 恢复消费点是既有的 useEditorRevealStore：EditorView 挂载后会读该文件的
  // reveal 请求并 setPosition + revealPositionInCenterIfOutsideViewport。
  // 复用它而不是新造一条通道——EditorView 侧零改动，且「跳到某行」的时序
  // 问题（Monaco 未挂载 / markdown 预览模式）那边已经处理过了。
  onRestoreState: (newTabId, snapshot) => {
    const cursor = snapshot.viewState?.editorCursor;
    if (!cursor || !snapshot.filePath) return;
    // 先把状态放回新标签名下，组件挂载后若继续上报即在此基础上累积。
    reportTabViewState(newTabId, { editorCursor: cursor });
    useEditorRevealStore.getState().request(snapshot.filePath, cursor.line, cursor.column);
  },
};

/** 无后端资源、无守卫的显式 no-op 登记（工厂产实例，未来分化互不影响）。 */
function inertEntry(): TabLifecycleEntry {
  return {
    // 四种「面板类」标签只吃公共底座（标题由调用方按 `前缀 - 项目名` 拼好传入）。
    createDefaults: () => ({}),
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
  dsh: dshEntry,
  "agent-chat": agentChatEntry,
  editor: editorEntry,
  "file-explorer": inertEntry(),
  "mcp-config": inertEntry(),
  "skill-manager": inertEntry(),
  "memory-manager": inertEntry(),
};
