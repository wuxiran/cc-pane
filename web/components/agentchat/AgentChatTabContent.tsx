// agent-chat 标签内容：ACP 结构化 agent 对话（气泡 + 工具卡 + 审批卡）。
//
// 会话真身在 Rust 的 AcpChatService 里，消息流在 useAgentChatStore——本组件
// 卸载（切标签/切布局）不影响会话，重挂载时从 store 恢复画面并向后端对账
// 一次快照（进程可能在组件不在场时退出）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ListTodo, Loader2, RotateCcw, Send, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import type { AcpEngineInfo, AgentChatItem } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import {
  ensureAgentChatListener,
  useAgentChatStore,
} from "@/stores/useAgentChatStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import PermissionCard from "./PermissionCard";
import ToolCallCard from "./ToolCallCard";

function ItemView({ item }: { item: AgentChatItem }) {
  const { t } = useTranslation("panes");
  switch (item.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-[var(--app-active-bg)] px-3 py-1.5 text-sm whitespace-pre-wrap break-words">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {item.text}
        </div>
      );
    case "thought":
      return (
        <div className="border-l-2 border-[var(--app-border)] pl-2 text-xs italic text-[var(--app-icon-inactive)] whitespace-pre-wrap break-words">
          {item.text}
        </div>
      );
    case "tool_call":
      return <ToolCallCard call={item.call} />;
    case "plan":
      return (
        <div className="rounded-md border border-[var(--app-border)] px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--app-icon-inactive)]">
            <ListTodo className="h-3.5 w-3.5" /> {t("agentChatPlanTitle")}
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {item.entries.map((entry, index) => (
              <li key={index} className="flex items-start gap-1.5 text-xs">
                <span
                  className={
                    entry.status === "completed"
                      ? "text-[var(--app-status-success)]"
                      : entry.status === "in_progress"
                        ? "text-[var(--app-status-warning)]"
                        : "text-[var(--app-icon-inactive)]"
                  }
                >
                  {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "▸" : "○"}
                </span>
                <span
                  className={
                    entry.status === "completed"
                      ? "line-through text-[var(--app-icon-inactive)]"
                      : ""
                  }
                >
                  {entry.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "notice":
      return (
        <div className="text-center text-[11px] text-[var(--app-icon-inactive)] break-all">
          {item.text}
        </div>
      );
    default:
      return null;
  }
}

function EnginePicker({
  tab,
  onStarted,
}: {
  tab: Tab;
  onStarted: () => void;
}) {
  const { t } = useTranslation("panes");
  const [engines, setEngines] = useState<AcpEngineInfo[] | null>(null);
  const [startingEngine, setStartingEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    agentChatService
      .listEngines()
      .then((list) => {
        if (!cancelled) setEngines(list);
      })
      .catch((listError) => {
        handleErrorSilent(listError, "list acp engines");
        if (!cancelled) setEngines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(
    async (engineId: string) => {
      setError(null);
      setStartingEngine(engineId);
      try {
        const snapshot = await agentChatService.start(tab.id, engineId, tab.projectPath);
        useAgentChatStore.getState().setSnapshot(tab.id, snapshot);
        onStarted();
      } catch (startError) {
        setError(startError instanceof Error ? startError.message : String(startError));
      } finally {
        setStartingEngine(null);
      }
    },
    [tab.id, tab.projectPath, onStarted],
  );

  if (!tab.projectPath) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--app-icon-inactive)]">
        {t("agentChatNoProject")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
      <Bot className="h-10 w-10 opacity-30" />
      <div className="text-sm text-[var(--app-icon-inactive)]">{t("agentChatPickEngine")}</div>
      <div className="flex w-full max-w-sm flex-col gap-2">
        {engines === null ? (
          <div className="flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--app-icon-inactive)]" />
          </div>
        ) : (
          engines.map((engine) => (
            <button
              key={engine.id}
              type="button"
              disabled={startingEngine !== null}
              className="flex items-center justify-between rounded-md border border-[var(--app-border)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
              onClick={() => void start(engine.id)}
            >
              <span>{engine.label}</span>
              {startingEngine === engine.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : engine.available ? (
                <span className="text-[11px] text-[var(--app-status-success)]">●</span>
              ) : (
                <span
                  className="text-[11px] text-[var(--app-icon-inactive)]"
                  title={engine.requirement}
                >
                  {t("agentChatUnavailableEngine")}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      {startingEngine ? (
        <div className="text-xs text-[var(--app-icon-inactive)]">{t("agentChatStarting")}</div>
      ) : null}
      {error ? (
        <div className="max-w-md whitespace-pre-wrap break-all text-center text-xs text-[var(--app-status-danger)]">
          {t("agentChatStartFailed")}: {error}
        </div>
      ) : null}
    </div>
  );
}

export default function AgentChatTabContent({ tab }: { tab: Tab }) {
  const { t } = useTranslation("panes");
  const chat = useAgentChatStore((state) => state.chats[tab.id]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

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
    if (!stickToBottomRef.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items, chat?.pendingPermission]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    stickToBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }, []);

  const snapshot = chat?.snapshot ?? null;
  const phase = snapshot?.phase;

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || phase !== "ready") return;
    setDraft("");
    stickToBottomRef.current = true;
    useAgentChatStore.getState().addUserMessage(tab.id, text);
    void agentChatService.prompt(tab.id, text).catch((error) => {
      useAgentChatStore
        .getState()
        .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
    });
  }, [draft, phase, tab.id]);

  const cancel = useCallback(() => {
    void agentChatService.cancel(tab.id).catch((error) => {
      handleErrorSilent(error, "cancel acp chat turn");
    });
  }, [tab.id]);

  const restart = useCallback(() => {
    const engineId = useAgentChatStore.getState().chats[tab.id]?.snapshot?.engineId;
    if (!engineId || !tab.projectPath) return;
    useAgentChatStore.getState().pushNotice(tab.id, `— ${t("agentChatRestart")} —`);
    void agentChatService
      .start(tab.id, engineId, tab.projectPath)
      .then((snapshot) => useAgentChatStore.getState().setSnapshot(tab.id, snapshot))
      .catch((error) => {
        useAgentChatStore
          .getState()
          .pushNotice(tab.id, error instanceof Error ? error.message : String(error));
      });
  }, [tab.id, tab.projectPath, t]);

  // 尚未启动过（没有快照也没有消息）→ 引擎选择页。
  if (!snapshot && (!items || items.length === 0)) {
    return <EnginePicker tab={tab} onStarted={() => undefined} />;
  }

  const generating = phase === "generating";
  const ended = phase === "exited" || phase === "failed";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-3"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
          {(items ?? []).map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
          {generating ? (
            <div className="flex items-center gap-1.5 text-xs text-[var(--app-icon-inactive)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("agentChatThinking")}
            </div>
          ) : null}
        </div>
      </div>

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
          {tab.projectPath ? (
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
        <div className="border-t border-[var(--app-border)] px-3 py-2">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={t("agentChatSendPlaceholder")}
              rows={2}
              className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-md border border-[var(--app-border)] bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-[var(--app-icon-active)]"
            />
            {generating ? (
              <button
                type="button"
                aria-label={t("agentChatStop")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-status-danger)] transition-colors hover:bg-[var(--app-hover)]"
                onClick={cancel}
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                aria-label={t("agentChatSend")}
                disabled={phase !== "ready" || !draft.trim()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-40"
                onClick={send}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
