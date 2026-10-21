// agent-chat 标签内容：ACP 结构化 agent 对话（气泡 + 工具卡 + 审批卡）。
//
// 会话真身在 Rust 的 AcpChatService 里，消息流在 useAgentChatStore——本组件
// 卸载（切标签/切布局）不影响会话，重挂载时从 store 恢复画面并向后端对账
// 一次快照（进程可能在组件不在场时退出）。
//
// 拆分（行数棘轮）：条目渲染在 ChatItems，输入区在 ChatComposer，引擎选择页
// 在 EnginePicker——本文件只管会话壳（头部/滚动/审批/生命周期动作）。
import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { ArrowDown, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import type { AcpPlanEntry, AgentChatItem } from "@/types/agentChat";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { supportsAcpFork, type ChatForkMode } from "@/services/chatForkService";
import { agentChatService } from "@/services/agentChatService";
import { todoService } from "@/services/todoService";
import { dropAgentChatState, ensureAgentChatListener } from "@/stores/agentChatEvents";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { usePanesStore } from "@/stores";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import ChatChangesPanel, { collectNetChanges } from "./ChatChangesPanel";
import ChatComposer from "./ChatComposer";
import ChatSessionHeader from "./ChatSessionHeader";
import ChatTurnView from "./ChatTurnView";
import ChatTimelineNavigation from "./ChatTimelineNavigation";
import ChatWelcome from "./ChatWelcome";
import "./agentChatAppearance.css";
import ChatSessionControls from "./ChatSessionControls";
import { groupChatItems, type ChatTurn } from "./chatTurns";
import { useChatTurnWindow } from "./useChatTurnWindow";
import EnginePicker from "./EnginePicker";
import SessionWorkspaceMenu from "./SessionWorkspaceMenu";
import ChatPermissionQueue from "./ChatPermissionQueue";
import ChatQuestionQueue from "./ChatQuestionQueue";
import { startConfiguredChat } from "./startConfiguredChat";
import { isAbsolutePath, joinCwd, residentAgentChatCwd } from "./chatPaths";

const ChatForkDialog = lazyWithRetry(() => import("@/components/chatfork/ChatForkDialog"), "ChatForkDialog");
const ForkReviewDialog = lazyWithRetry(() => import("@/components/chatfork/ForkReviewDialog"), "ForkReviewDialog");


/** 会话转写 → Markdown（导出用；工具卡只留标题行，diff 太重不进转写）。 */
function transcriptMarkdown(items: AgentChatItem[]): string {
  const sections: string[] = [];
  for (const item of items) {
    if (item.type === "user") sections.push(`## User\n\n${item.text}`);
    else if (item.type === "assistant") sections.push(`## Assistant\n\n${item.text}`);
    else if (item.type === "thought") sections.push(`> ${item.text.replace(/\n/g, "\n> ")}`);
    else if (item.type === "tool_call") {
      sections.push(`- \`${item.call.kind ?? "tool"}\` ${item.call.title ?? item.call.toolCallId} (${item.call.status ?? "pending"})`);
    } else if (item.type === "plan") {
      sections.push(item.entries.map((entry) => `- [ ] ${entry.content}`).join("\n"));
    }
  }
  return sections.join("\n\n");
}

export default function AgentChatTabContent({ tab }: { tab: Tab }) {
  const { t } = useTranslation("panes");
  const chat = useAgentChatStore((state) => state.chats[tab.id]);
  const [atBottom, setAtBottom] = useState(true);
  const [forkOpen, setForkOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const forkSource = useRef<{ engineId: string; sessionId: string; cwd: string } | null>(null);
  // 工作空间/目录覆盖存 store（切标签不丢），优先级高于标签自带项目；
  // 顶栏 chip 与启动页共用 StartProjectMenu 切换。
  const cwdOverride = chat?.cwdOverride ?? null;
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  // 既没覆盖也没带项目时（专用布局自动补的空标签、首页直接开聊），回退到
  // Agent Chat 常驻工作空间：聊天永远要有一个真实存在的 cwd。
  const effectiveCwd = cwdOverride || tab.projectPath || residentAgentChatCwd(workspaces);
  const setCwdOverride = useCallback(
    (cwd: string | null) => useAgentChatStore.getState().setCwdOverride(tab.id, cwd),
    [tab.id],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 工具卡全局展开/折叠信号（seq 递增触发，各卡自行响应）。
  const [toolFold, setToolFold] = useState<{ seq: number; expanded: boolean }>({
    seq: 0,
    expanded: false,
  });
  // 本轮改动审查面板开关。
  const [showChanges, setShowChanges] = useState(false);
  const [recoverySelections, setRecoverySelections] = useState<Record<string, string>>({});
  useEffect(() => setRecoverySelections({}), [tab.id, chat?.setup?.token]);

  useEffect(() => {
    ensureAgentChatListener();
    // 重挂载对账：store 有画面但进程可能已死（或反之）。后端不存在该会话时
    // 返回 null，保持 store 原样（画面还在，phase 停在最后已知值）。
    if (!useAgentChatStore.getState().chats[tab.id]?.snapshot) {
      void agentChatService
        .get(tab.id)
        .then((snapshot) => {
          if (snapshot) useAgentChatStore.getState().setSnapshot(tab.id, snapshot);
        })
        .catch((error) => handleErrorSilent(error, "reconcile acp chat"));
    }
  }, [tab.id]);

  const items = chat?.items;
  useEffect(() => {
    if (!atBottom) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items, chat?.pendingPermissions, chat?.pendingElicitations, atBottom]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
  }, []);

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setAtBottom(true);
  }, []);

  const snapshot = chat?.snapshot ?? null;
  const phase = chat?.setup?.pending || chat?.pendingPrompt ? "starting" : chat?.setup?.error ? "failed" : snapshot?.phase;
  // 配置失败但进程仍就绪：允许修改下次启动的偏好，继续禁止发送；真实退出不开放此入口。
  const setupRecovery = Boolean(chat?.setup?.error) && snapshot?.phase === "ready";
  const availableCommands = chat?.availableCommands ?? [];
  const changesCount = useMemo(() => collectNetChanges(items ?? []).length, [items]);
  const turns = useMemo(() => groupChatItems(items ?? []), [items]);
  const [visibleCount, setVisibleCount] = useChatTurnWindow(turns, !atBottom);

  const timelineKey = snapshot?.acpSessionId
    ? JSON.stringify([snapshot.engineId, snapshot.acpSessionId]) : tab.id;
  const revealTimelineTurn = useCallback((index: number) => {
    setVisibleCount((previous) => Math.max(previous, turns.length - index));
  }, [turns.length]);
  const leaveLatest = useCallback(() => setAtBottom(false), []);

  const copyMarkdown = useCallback(() => {
    void navigator.clipboard
      .writeText(transcriptMarkdown(items ?? []))
      .then(() => {
        useAgentChatStore.getState().pushNotice(tab.id, t("agentChatExportCopied"));
      })
      .catch((error) => handleErrorSilent(error, "copy acp transcript markdown"));
  }, [items, tab.id, t]);

  const openLocation = useCallback(
    (path: string, line?: number) => {
      const absolute = isAbsolutePath(path) ? path : joinCwd(effectiveCwd || ".", path);
      const title = absolute.split(/[\\/]/).pop() || absolute;
      usePanesStore
        .getState()
        .openEditor(tab.projectPath || effectiveCwd, absolute, title, undefined, {
          forcePaneTab: true,
        });
      if (line !== undefined) {
        useEditorRevealStore.getState().request(absolute, line, 1);
      }
    },
    [effectiveCwd, tab.projectPath],
  );

  const planToTodo = useCallback(
    (entries: AcpPlanEntry[]) => {
      const pending = entries.filter((entry) => entry.content.trim());
      void Promise.all(
        pending.map((entry) => todoService.create({ title: entry.content.trim() })),
      )
        .then(() => {
          useAgentChatStore
            .getState()
            .pushNotice(tab.id, t("agentChatPlanTodoCreated", { count: pending.length }));
        })
        .catch((error) => {
          useAgentChatStore
            .getState()
            .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
        });
    },
    [tab.id, t],
  );

  const forkToNewTab = useCallback(async (mode: ChatForkMode) => {
    const expected = forkSource.current;
    if (!expected) throw new Error(t("forkUnsupported"));
    const readSource = () => {
      const current = useAgentChatStore.getState().chats[tab.id];
      const cwd = current?.cwdOverride || tab.projectPath
        || residentAgentChatCwd(useWorkspacesStore.getState().workspaces);
      if (current?.setup?.pending || current?.setup?.error || current?.pendingPrompt
        || current?.snapshot?.phase !== "ready"
        || current.snapshot.acpSessionId !== expected.sessionId
        || current.snapshot.engineId !== expected.engineId || cwd !== expected.cwd
        || !supportsAcpFork(current.snapshot.agentCapabilities)) {
        throw new Error(t("forkUnsupported"));
      }
      return current;
    };
    readSource();
    const newTabId = `tab-${crypto.randomUUID()}`;
    const { forkReviewService } = await import("@/services/forkReviewService");
    readSource();
    const prepared = await forkReviewService.prepare({
      cwd: expected.cwd, mode, sourceTabId: tab.id, childTabId: newTabId,
      sourceSessionId: expected.sessionId, title: tab.title, engineId: expected.engineId,
    });
    const cwd = prepared.cwd;
    let started = false;
    try {
      // The dialog and worktree operation can outlive a restart or project switch.
      const source = readSource();
      const transcript = structuredClone(source.items);
      started = true;
      const snapshot = await agentChatService.fork(tab.id, newTabId, cwd);
      if (!snapshot.acpSessionId) throw new Error("Fork returned no independent session ID");
      useAgentChatStore.getState().seedFork(newTabId, transcript, snapshot.acpSessionId, source.transcriptStart);
      useAgentChatStore.getState().setSnapshot(newTabId, snapshot);
      if (!usePanesStore.getState().openAgentChat(cwd, { tabId: newTabId, parentTabId: tab.id, forkReviewId: prepared.record?.id })) {
        throw new Error("Unable to open the forked conversation tab");
      }
    } catch (error) {
      if (started) {
        await agentChatService.stop(newTabId).catch((stopError) => handleErrorSilent(stopError, "stop failed fork"));
        dropAgentChatState(newTabId);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(mode === "worktree" ? `${detail}\n${cwd}` : detail);
    }
  }, [tab.id, tab.title, tab.projectPath, t]);

  const copySessionId = useCallback(() => {
    const sessionId = useAgentChatStore.getState().chats[tab.id]?.snapshot?.acpSessionId;
    if (!sessionId) return;
    void navigator.clipboard
      .writeText(sessionId)
      .catch((error) => handleErrorSilent(error, "copy acp session id"));
  }, [tab.id]);

  const restart = useCallback(() => {
    const current = useAgentChatStore.getState().chats[tab.id]?.snapshot;
    if (!current?.engineId || !effectiveCwd) return;
    useAgentChatStore.getState().pushNotice(tab.id, `— ${t("agentChatRestart")} —`);
    const setup = useAgentChatStore.getState().chats[tab.id]?.setup;
    void startConfiguredChat({
      chatId: tab.id,
      engineId: current.engineId,
      cwd: effectiveCwd,
      resumeAcpSessionId: current.acpSessionId,
      autoApproveKinds: current.autoApproveKinds,
      firstPrompt: setup?.firstPrompt,
      preamble: setup?.preamble,
    }).catch((error) => handleErrorSilent(error, "restart acp chat"));
  }, [tab.id, effectiveCwd, t]);

  // 尚未启动过（没有快照也没有消息）→ 引擎选择页。
  if (!snapshot && (!items || items.length === 0)) {
    return (
      <div className="agent-chat-shell flex h-full min-w-0 flex-col overflow-hidden">
        <EnginePicker
          chatId={tab.id}
          cwd={effectiveCwd}
          onPickCwd={setCwdOverride}
          onCwdAdopted={setCwdOverride}
        />
      </div>
    );
  }

  const generating = phase === "generating";
  const ended = phase === "exited" || phase === "failed";
  const engineLabel = snapshot?.engineId ?? "agent";
  // 生成中但 agent 还没吐出任何条目（刚发出去 / 上一条是用户）：先立一个空回合承载状态行。
  const lastTurn = turns[turns.length - 1];
  const pendingTurn: ChatTurn | null =
    generating && lastTurn?.kind !== "assistant"
      ? { kind: "assistant", id: "pending-turn", at: Date.now(), blocks: [] }
      : null;

  // Recovery edits preferences only; setup-pending and exited sessions stay gated.
  const composerToolbar = snapshot && (!ended || setupRecovery) && !chat?.setup?.pending && !chat?.pendingPrompt ? (
    <ChatSessionControls
      chatId={tab.id}
      snapshot={snapshot}
      setupRecovery={setupRecovery}
      recoverySelections={recoverySelections}
      onRecoverySelect={(key, value) => setRecoverySelections((previous) => ({ ...previous, [key]: value }))}
    />
  ) : null;

  return (
    <section className="agent-chat-shell h-full min-w-0">
    <div className="flex h-full flex-col overflow-hidden">
      {forkOpen && <Suspense fallback={null}><ChatForkDialog open={forkOpen} onOpenChange={setForkOpen} onFork={forkToNewTab} /></Suspense>}
      {reviewOpen && <Suspense fallback={null}><ForkReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} forkReviewId={tab.forkReviewId} cwd={effectiveCwd} sourceSessionId={snapshot?.acpSessionId} /></Suspense>}
      {snapshot ? (
        <ChatSessionHeader
          engineLabel={snapshot.engineId}
          workspaceMenu={
            <SessionWorkspaceMenu chatId={tab.id} cwd={effectiveCwd} generating={generating} />
          }
          generating={generating}
          changesCount={changesCount}
          showChanges={showChanges}
          onToggleChanges={() => setShowChanges((previous) => !previous)}
          toolsExpanded={toolFold.expanded}
          onToggleTools={() =>
            setToolFold((previous) => ({ seq: previous.seq + 1, expanded: !previous.expanded }))
          }
          canFork={Boolean(snapshot.acpSessionId && effectiveCwd && phase === "ready" && supportsAcpFork(snapshot.agentCapabilities))}
          onFork={() => {
            if (!snapshot.acpSessionId || !effectiveCwd) return;
            forkSource.current = { engineId: snapshot.engineId, sessionId: snapshot.acpSessionId, cwd: effectiveCwd };
            setForkOpen(true);
          }}
          onReviewFork={() => setReviewOpen(true)}
          hasForkOrigin={Boolean(tab.forkReviewId)}
          canCopySessionId={Boolean(snapshot.acpSessionId)}
          onCopySessionId={copySessionId}
          canExport={Boolean(items && items.length > 0)}
          onExport={copyMarkdown}
        />
      ) : null}
      <div className="relative flex-1 overflow-hidden">
        <ChatTimelineNavigation
          key={timelineKey}
          conversationKey={timelineKey}
          turns={turns}
          scrollRef={scrollRef}
          visibleCount={visibleCount}
          onReveal={revealTimelineTurn}
          onNavigate={leaveLatest}
        />
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="agent-chat-scroll h-full overflow-y-auto"
        >
          <div className="agent-chat-reading-column mx-auto flex min-w-0 max-w-3xl flex-col">
            {snapshot && turns.length === 0 ? (
              <ChatWelcome
                engineLabel={engineLabel}
                cwd={effectiveCwd}
                concierge={chat?.concierge ?? false}
              />
            ) : null}
            {turns.length > visibleCount ? (
              <button
                type="button"
                className="agent-chat-earlier flex w-full items-center border-b border-[var(--app-border)] py-3 text-left text-xs text-[var(--app-text-tertiary)] transition-colors hover:text-[var(--app-text-primary)]"
                onClick={() => setVisibleCount((previous) => previous + 60)}
              >
                {t("agentChatShowEarlier", { count: turns.length - visibleCount })}
              </button>
            ) : null}
            {turns.slice(-visibleCount).map((turn, index, visible) => (
              <div className="agent-chat-turn" data-turn-kind={turn.kind} key={turn.id} data-chat-turn-id={turn.id} data-chat-turn-index={Math.max(0, turns.length - visibleCount) + index}>
                <ChatTurnView
                  turn={turn}
                  engineLabel={engineLabel}
                  streaming={generating && !pendingTurn && index === visible.length - 1}
                  chatId={tab.id}
                  cwd={effectiveCwd}
                  onOpenLocation={openLocation}
                  onPlanToTodo={planToTodo}
                  expandAllSignal={toolFold}
                />
              </div>
            ))}
            {pendingTurn ? (
              <ChatTurnView
                turn={pendingTurn}
                engineLabel={engineLabel}
                streaming
                chatId={tab.id}
                cwd={effectiveCwd}
                onOpenLocation={openLocation}
                onPlanToTodo={planToTodo}
              />
            ) : null}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            aria-label={t("agentChatJumpLatest")}
            className="absolute bottom-3 right-4 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[var(--app-text-secondary)] shadow-md transition-colors hover:text-[var(--app-text-primary)]"
            onClick={jumpToLatest}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {showChanges ? (
        <ChatChangesPanel
          items={items ?? []}
          cwd={effectiveCwd}
          onOpenFile={(path) => openLocation(path)}
        />
      ) : null}

      <ChatPermissionQueue chatId={tab.id} />
      <ChatQuestionQueue chatId={tab.id} />

      {ended ? (
        <div className="agent-chat-ended px-3 pb-3 pt-1">
          {setupRecovery ? (
            <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-2 text-xs text-[var(--app-text-secondary)]">
              <span>{t("agentChatSetupRecovery")}</span>
              <div className="flex flex-wrap items-center gap-1">{composerToolbar}</div>
            </div>
          ) : null}
          <div className="mx-auto flex max-w-3xl items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-chat-composer-bg)] px-3 py-3 text-xs text-[var(--app-text-tertiary)]">
            {!setupRecovery ? <span>{t("agentChatEnded")}</span> : null}
            {effectiveCwd ? (
              <button
                type="button"
                className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-overlay)] px-2.5 py-1 text-[var(--app-text-secondary)] shadow-sm transition-colors hover:text-[var(--app-text-primary)]"
                onClick={restart}
              >
                <RotateCcw className="h-3 w-3" /> {t("agentChatRestart")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <ChatComposer
          chatId={tab.id}
          cwd={effectiveCwd}
          phase={phase}
          generating={generating}
          availableCommands={availableCommands}
          onBeforeSend={() => setAtBottom(true)}
          toolbar={composerToolbar}
          usage={chat?.usage ?? null}
        />
      )}
    </div>
    </section>
  );
}
