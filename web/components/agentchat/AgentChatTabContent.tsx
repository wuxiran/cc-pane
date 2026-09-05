// agent-chat 标签内容：ACP 结构化 agent 对话（气泡 + 工具卡 + 审批卡）。
//
// 会话真身在 Rust 的 AcpChatService 里，消息流在 useAgentChatStore——本组件
// 卸载（切标签/切布局）不影响会话，重挂载时从 store 恢复画面并向后端对账
// 一次快照（进程可能在组件不在场时退出）。
//
// 拆分（行数棘轮）：条目渲染在 ChatItems，输入区在 ChatComposer，引擎选择页
// 在 EnginePicker——本文件只管会话壳（头部/滚动/审批/生命周期动作）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Bot,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCopy,
  Copy,
  Cpu,
  FileDiff,
  GitFork,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Tab } from "@/types";
import type { AcpPlanEntry, AgentChatItem } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { todoService } from "@/services/todoService";
import {
  ensureAgentChatListener,
  useAgentChatStore,
} from "@/stores/useAgentChatStore";
import { usePanesStore } from "@/stores";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import ChatChangesPanel, { collectNetChanges } from "./ChatChangesPanel";
import ChatComposer from "./ChatComposer";
import ChatTurnView from "./ChatTurnView";
import ChatWelcome from "./ChatWelcome";
import ConfigOptionSelectors from "./ConfigOptionSelectors";
import { HeaderSelect } from "./ChatItems";
import { groupChatItems, type ChatTurn } from "./chatTurns";
import EnginePicker from "./EnginePicker";
import PermissionCard from "./PermissionCard";
import PermissionPolicyDropdown from "./PermissionPolicyDropdown";
import { isAbsolutePath, joinCwd } from "./chatPaths";
import {
  loadAutoApproveKinds,
  saveAutoApproveKinds,
  saveEngineModels,
  saveEngineModes,
  savePreferredConfigOption,
  savePreferredMode,
  savePreferredModel,
} from "./enginePrefs";

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
  // 空壳窗格开出来的标签没有项目路径：用户在引擎选择页现选目录，选择结果
  // 只活在组件内（会话真身在后端，重挂载后从快照对账，不依赖这里持久化）。
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const effectiveCwd = tab.projectPath || cwdOverride || "";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 长会话分页：只渲染最近 N 个回合，顶部按钮逐段放开（防几百条全量渲染掉帧）。
  const [visibleCount, setVisibleCount] = useState(60);
  // 工具卡全局展开/折叠信号（seq 递增触发，各卡自行响应）。
  const [toolFold, setToolFold] = useState<{ seq: number; expanded: boolean }>({
    seq: 0,
    expanded: false,
  });
  // 本轮改动审查面板开关。
  const [showChanges, setShowChanges] = useState(false);

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
  }, [items, chat?.pendingPermission, atBottom]);

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
  const phase = snapshot?.phase;
  const availableCommands = chat?.availableCommands ?? [];
  const changesCount = useMemo(() => collectNetChanges(items ?? []).length, [items]);
  const turns = useMemo(() => groupChatItems(items ?? []), [items]);

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

  /** 分叉：新开一个 agent-chat 标签，用 session/load 续接当前对话上下文。
   * claude 的 resume 语义天然分叉（原会话文件不动，续接产生新线），两个
   * 标签各自往下走。 */
  const forkToNewTab = useCallback(() => {
    const current = useAgentChatStore.getState().chats[tab.id]?.snapshot;
    if (!current?.acpSessionId || !effectiveCwd) return;
    const newTabId = usePanesStore.getState().openAgentChat(effectiveCwd);
    if (!newTabId) return;
    void agentChatService
      .start(
        newTabId,
        current.engineId,
        effectiveCwd,
        current.acpSessionId,
        current.autoApproveKinds ?? loadAutoApproveKinds(current.engineId),
      )
      .then((snapshot) => useAgentChatStore.getState().setSnapshot(newTabId, snapshot))
      .catch((error) => {
        useAgentChatStore
          .getState()
          .pushNotice(newTabId, error instanceof Error ? error.message : String(error));
      });
  }, [tab.id, effectiveCwd]);

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
    void agentChatService
      .start(
        tab.id,
        current.engineId,
        effectiveCwd,
        current.acpSessionId,
        current.autoApproveKinds ?? loadAutoApproveKinds(current.engineId),
      )
      .then((snapshot) => useAgentChatStore.getState().setSnapshot(tab.id, snapshot))
      .catch((error) => {
        useAgentChatStore
          .getState()
          .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
      });
  }, [tab.id, effectiveCwd, t]);

  // 尚未启动过（没有快照也没有消息）→ 引擎选择页。
  if (!snapshot && (!items || items.length === 0)) {
    return (
      <EnginePicker
        chatId={tab.id}
        cwd={effectiveCwd}
        onPickCwd={setCwdOverride}
        onCwdAdopted={setCwdOverride}
      />
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

  const modeItems = (snapshot?.modes?.availableModes ?? []).map((mode) => ({
    id: mode.id,
    label: mode.name || mode.id,
    description: mode.description,
  }));
  const modelItems = (snapshot?.models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    label: model.name || model.modelId,
    description: model.description,
  }));
  const autoApproveKinds = snapshot?.autoApproveKinds ?? [];
  // legacy 选择器在渲染的类别，configOptions 里同类不再重复出一个。
  const legacyCategories = new Set<string>([
    ...(modelItems.length > 0 ? ["model"] : []),
    ...(modeItems.length > 0 ? ["mode"] : []),
  ]);

  const pushError = (error: unknown) => {
    useAgentChatStore
      .getState()
      .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
  };

  // composer 底栏：模型 / 模式 / 权限（会话结束后不再可改）。
  const composerToolbar = snapshot && !ended ? (
    <>
      {modelItems.length > 0 ? (
        <HeaderSelect
          icon={<Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          items={modelItems}
          currentId={snapshot.models?.currentModelId}
          onSelect={(modelId) => {
            // 记为该引擎的偏好模型，下次启动页直接可选并自动应用。
            savePreferredModel(snapshot.engineId, modelId);
            saveEngineModels(snapshot.engineId, snapshot.models?.availableModels ?? []);
            void agentChatService.setModel(tab.id, modelId).catch(pushError);
          }}
        />
      ) : null}
      {modeItems.length > 0 ? (
        <HeaderSelect
          icon={<SlidersHorizontal className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          items={modeItems}
          currentId={snapshot.modes?.currentModeId}
          onSelect={(modeId) => {
            savePreferredMode(snapshot.engineId, modeId);
            saveEngineModes(snapshot.engineId, snapshot.modes?.availableModes ?? []);
            void agentChatService.setMode(tab.id, modeId).catch(pushError);
          }}
        />
      ) : null}
      <ConfigOptionSelectors
        options={snapshot.configOptions}
        hiddenCategories={legacyCategories}
        onSelect={(option, value) => {
          // mode/model 类别（legacy 缺席时才从这里出）沿用原偏好字段；其余记进配置项偏好。
          if (option.category === "model") savePreferredModel(snapshot.engineId, value);
          else if (option.category === "mode") savePreferredMode(snapshot.engineId, value);
          else savePreferredConfigOption(snapshot.engineId, option.configId, value);
          void agentChatService.setConfigOption(tab.id, option.configId, value).catch(pushError);
        }}
      />
      <PermissionPolicyDropdown
        kinds={autoApproveKinds}
        onChange={(kinds) => {
          // 同时落为引擎偏好（下次启动沿用）并对当前会话立即生效。
          saveAutoApproveKinds(snapshot.engineId, kinds);
          void agentChatService.setAutoApprove(tab.id, kinds).catch(pushError);
        }}
      />
    </>
  ) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {snapshot ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--app-active-bg)] text-[var(--app-accent)]">
            <Bot className="h-3 w-3" />
          </span>
          <span className="text-xs font-medium text-[var(--app-text-primary)]">
            {snapshot.engineId}
          </span>
          {generating ? (
            <span className="flex items-center gap-1 text-[11px] text-[var(--app-text-tertiary)]">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("agentChatThinking")}
            </span>
          ) : null}
          <span className="flex-1" />
          {changesCount > 0 ? (
            <button
              type="button"
              aria-label={t("agentChatChanges")}
              className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition-colors hover:bg-[var(--app-hover)] ${
                showChanges
                  ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]"
                  : "text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]"
              }`}
              onClick={() => setShowChanges((previous) => !previous)}
            >
              <FileDiff className="h-3.5 w-3.5" />
              {changesCount}
            </button>
          ) : null}
          <IconTooltipButton
            label={toolFold.expanded ? t("agentChatCollapseTools") : t("agentChatExpandTools")}
            className="h-6 w-6"
            onClick={() =>
              setToolFold((previous) => ({ seq: previous.seq + 1, expanded: !previous.expanded }))
            }
          >
            {toolFold.expanded ? (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            )}
          </IconTooltipButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("agentChatMore")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                disabled={!snapshot.acpSessionId || !effectiveCwd}
                onSelect={forkToNewTab}
              >
                <GitFork /> {t("agentChatContinueNewTab")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!snapshot.acpSessionId} onSelect={copySessionId}>
                <Copy /> {t("agentChatCopySessionId")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!items || items.length === 0} onSelect={copyMarkdown}>
                <ClipboardCopy /> {t("agentChatExportMarkdown")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-3 py-3"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {snapshot && turns.length <= visibleCount ? (
              <ChatWelcome
                engineLabel={engineLabel}
                cwd={effectiveCwd}
                concierge={chat?.concierge ?? false}
              />
            ) : null}
            {turns.length > visibleCount ? (
              <button
                type="button"
                className="mx-auto rounded border border-[var(--app-border)] px-2.5 py-1 text-[11px] text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)]"
                onClick={() => setVisibleCount((previous) => previous + 60)}
              >
                {t("agentChatShowEarlier", { count: turns.length - visibleCount })}
              </button>
            ) : null}
            {turns.slice(-visibleCount).map((turn, index, visible) => (
              <ChatTurnView
                key={turn.id}
                turn={turn}
                engineLabel={engineLabel}
                streaming={generating && !pendingTurn && index === visible.length - 1}
                chatId={tab.id}
                onOpenLocation={openLocation}
                onPlanToTodo={planToTodo}
                expandAllSignal={toolFold}
              />
            ))}
            {pendingTurn ? (
              <ChatTurnView
                turn={pendingTurn}
                engineLabel={engineLabel}
                streaming
                chatId={tab.id}
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

      {chat?.pendingPermission ? (
        <PermissionCard
          request={chat.pendingPermission}
          onRespond={(optionId) => {
            const requestKey = chat.pendingPermission?.requestKey;
            if (!requestKey) return;
            useAgentChatStore.getState().setPermission(tab.id, null);
            void agentChatService
              .respondPermission(tab.id, requestKey, optionId)
              .catch((error) => handleErrorSilent(error, "respond acp permission"));
          }}
        />
      ) : null}

      {ended ? (
        <div className="px-3 pb-3 pt-1">
          <div className="mx-auto flex max-w-3xl items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-chat-composer-bg)] px-3 py-3 text-xs text-[var(--app-text-tertiary)]">
            <span>{t("agentChatEnded")}</span>
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
  );
}
