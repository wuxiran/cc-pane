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
  FileDiff,
  GitFork,
  Loader2,
  MoreHorizontal,
  RotateCcw,
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
import ChatChangesPanel, { collectNetChanges } from "./ChatChangesPanel";
import ChatComposer from "./ChatComposer";
import { HeaderSelect, ItemView } from "./ChatItems";
import EnginePicker from "./EnginePicker";
import PermissionCard from "./PermissionCard";
import { isAbsolutePath, joinCwd } from "./chatPaths";
import {
  saveEngineModels,
  saveEngineModes,
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
  // 长会话分页：只渲染最近 N 条，顶部按钮逐段放开（防几百条全量渲染掉帧）。
  const [visibleCount, setVisibleCount] = useState(150);
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
      .start(newTabId, current.engineId, effectiveCwd, current.acpSessionId)
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
      .start(tab.id, current.engineId, effectiveCwd, current.acpSessionId)
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {snapshot ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3">
          <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" />
          <span className="text-[11px] font-medium text-[var(--app-icon-inactive)]">
            {snapshot.engineId}
          </span>
          <span className="flex-1" />
          {changesCount > 0 ? (
            <button
              type="button"
              aria-label={t("agentChatChanges")}
              title={t("agentChatChanges")}
              className={`flex items-center gap-1 rounded px-1 py-0.5 text-[11px] transition-colors hover:bg-[var(--app-hover)] ${
                showChanges
                  ? "text-[var(--app-accent)]"
                  : "text-[var(--app-icon-inactive)] hover:text-[var(--app-icon-active)]"
              }`}
              onClick={() => setShowChanges((previous) => !previous)}
            >
              <FileDiff className="h-3.5 w-3.5" />
              {changesCount}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={toolFold.expanded ? t("agentChatCollapseTools") : t("agentChatExpandTools")}
            title={toolFold.expanded ? t("agentChatCollapseTools") : t("agentChatExpandTools")}
            className="rounded p-0.5 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
            onClick={() =>
              setToolFold((previous) => ({ seq: previous.seq + 1, expanded: !previous.expanded }))
            }
          >
            {toolFold.expanded ? (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            )}
          </button>
          {!ended && modelItems.length > 0 ? (
            <HeaderSelect
              items={modelItems}
              currentId={snapshot.models?.currentModelId}
              onSelect={(modelId) => {
                // 记为该引擎的偏好模型，下次启动页直接可选并自动应用。
                savePreferredModel(snapshot.engineId, modelId);
                saveEngineModels(snapshot.engineId, snapshot.models?.availableModels ?? []);
                void agentChatService.setModel(tab.id, modelId).catch((error) => {
                  useAgentChatStore
                    .getState()
                    .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
                });
              }}
            />
          ) : null}
          {!ended && modeItems.length > 0 ? (
            <HeaderSelect
              items={modeItems}
              currentId={snapshot.modes?.currentModeId}
              onSelect={(modeId) => {
                savePreferredMode(snapshot.engineId, modeId);
                saveEngineModes(snapshot.engineId, snapshot.modes?.availableModes ?? []);
                void agentChatService.setMode(tab.id, modeId).catch((error) => {
                  useAgentChatStore
                    .getState()
                    .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
                });
              }}
            />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("agentChatMore")}
                className="rounded p-0.5 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
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
          <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
            {items && items.length > visibleCount ? (
              <button
                type="button"
                className="mx-auto rounded border border-[var(--app-border)] px-2.5 py-1 text-[11px] text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)]"
                onClick={() => setVisibleCount((previous) => previous + 200)}
              >
                {t("agentChatShowEarlier", { count: items.length - visibleCount })}
              </button>
            ) : null}
            {(items ?? []).slice(-visibleCount).map((item) => (
              <ItemView
                key={item.id}
                item={item}
                onOpenLocation={openLocation}
                onPlanToTodo={planToTodo}
                expandAllSignal={toolFold}
              />
            ))}
            {generating ? (
              <div className="flex items-center gap-1.5 text-xs text-[var(--app-icon-inactive)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("agentChatThinking")}
              </div>
            ) : null}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            aria-label={t("agentChatJumpLatest")}
            className="absolute bottom-3 right-4 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-hover)] text-[var(--app-icon-inactive)] shadow transition-colors hover:text-[var(--app-icon-active)]"
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
        <div className="flex items-center justify-center gap-3 border-t border-[var(--app-border)] px-3 py-2.5 text-xs text-[var(--app-icon-inactive)]">
          <span>{t("agentChatEnded")}</span>
          {effectiveCwd ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded border border-[var(--app-border)] px-2 py-1 transition-colors hover:bg-[var(--app-hover)]"
              onClick={restart}
            >
              <RotateCcw className="h-3 w-3" /> {t("agentChatRestart")}
            </button>
          ) : null}
        </div>
      ) : (
        <ChatComposer
          chatId={tab.id}
          cwd={effectiveCwd}
          phase={phase}
          generating={generating}
          availableCommands={availableCommands}
          onBeforeSend={() => setAtBottom(true)}
        />
      )}
    </div>
  );
}
