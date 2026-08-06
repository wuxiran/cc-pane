import { useCallback, useRef, useEffect } from "react";
import { selfChatOwnerId, useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { useActivityBarStore } from "@/stores";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { TerminalView } from "@/components/panes";
import type { TerminalViewHandle } from "@/components/panes";
import SelfChatContextBar from "./SelfChatContextBar";
import { useSelfChatStore, useSettingsStore, usePanesStore } from "@/stores";
import { selfChatService, terminalService } from "@/services";

const LOG_PREFIX = "[SelfChat]";

export default function SelfChatManager() {
  const { t } = useTranslation("common");

  const defaultCliTool = useSettingsStore((s) => s.settings?.general.defaultCliTool ?? "claude");
  // SelfChat 无自身 Provider 配置，必须成对继承 id + 三态模式。
  const activeProvider = usePanesStore(
    useShallow((s) => {
      const pane = s.findPaneById(s.activePaneId);
      if (pane?.type === "panel") {
        const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
        return {
          id: tab?.providerId,
          modelId: tab?.modelId,
          selection: tab?.providerSelection ?? ("inherit" as const),
        };
      }
      return { id: undefined, modelId: undefined, selection: "inherit" as const };
    }),
  );
  const activeSession = useSelfChatStore((s) => s.activeSession);
  const startSession = useSelfChatStore((s) => s.startSession);
  const updatePtySessionId = useSelfChatStore((s) => s.updatePtySessionId);
  const setStatus = useSelfChatStore((s) => s.setStatus);
  const endSession = useSelfChatStore((s) => s.endSession);

  const terminalRef = useRef<TerminalViewHandle>(null);
  const autoStartedRef = useRef(false);
  const terminalKeyRef = useRef(0);

  // 自动启动：进入 selfchat 模式时先收集上下文，再启动会话
  useEffect(() => {
    if (activeSession || autoStartedRef.current) return;
    autoStartedRef.current = true;

    const onboarding = useSelfChatStore.getState().isOnboarding;
    console.info(`${LOG_PREFIX} Auto-starting: collecting context + fetching app CWD... (onboarding=${onboarding})`);

    const collectPrompt = onboarding
      ? Promise.resolve(
          selfChatService.collectOnboardingContext(
            useSettingsStore.getState().settings?.general.language ?? "zh-CN"
          )
        )
      : selfChatService.collectAppContext();

    Promise.all([
      selfChatService.getAppCwd(),
      collectPrompt,
    ]).then(([cwd, prompt]) => {
      // 再次检查避免竞争
      if (useSelfChatStore.getState().activeSession) {
        console.warn(`${LOG_PREFIX} Race condition: session already exists, skipping start`);
        return;
      }
      console.info(`${LOG_PREFIX} Starting session, appCwd=${cwd}, promptLen=${prompt.length}`);
      startSession(cwd, prompt);
      terminalKeyRef.current += 1;
    }).catch((err) => {
      console.error(`${LOG_PREFIX} FAILED to init:`, err);
      autoStartedRef.current = false;
    });
  }, [activeSession, startSession]);

  const handleRestart = useCallback(() => {
    console.info(`${LOG_PREFIX} Restart requested`);
    if (activeSession) {
      if (activeSession.ptySessionId) {
        console.info(`${LOG_PREFIX} Killing PTY session: ${activeSession.ptySessionId}`);
        terminalService.killSession(activeSession.ptySessionId).catch((err) => {
          console.error(`${LOG_PREFIX} Kill session failed:`, err);
        });
      }
      endSession(activeSession.id);
    }
    autoStartedRef.current = false;
    // 重置后 useEffect 会自动重新启动
  }, [activeSession, endSession]);

  const handleEndSession = useCallback(() => {
    if (!activeSession) return;
    console.info(`${LOG_PREFIX} End session requested, id=${activeSession.id}`);
    if (activeSession.ptySessionId) {
      terminalService.killSession(activeSession.ptySessionId).catch((err) => {
        console.error(`${LOG_PREFIX} Kill session failed:`, err);
      });
    }
    endSession(activeSession.id);
    autoStartedRef.current = false;
  }, [activeSession, endSession]);

  const handleSessionCreated = useCallback(
    (ptySessionId: string) => {
      const session = useSelfChatStore.getState().activeSession;
      if (session) {
        console.info(`${LOG_PREFIX} PTY session created: ${ptySessionId}, selfChatId=${session.id}`);
        updatePtySessionId(session.id, ptySessionId);
        setStatus(session.id, "running");

        // Onboarding 模式：延时自动发送初始消息触发 Claude 引导回复
        if (useSelfChatStore.getState().isOnboarding) {
          console.info(`${LOG_PREFIX} Onboarding mode: will auto-send initial message in 5s`);
          setTimeout(() => {
            const current = useSelfChatStore.getState().activeSession;
            if (current?.ptySessionId === ptySessionId && current.status === "running") {
              console.info(`${LOG_PREFIX} Sending onboarding initial message`);
              terminalService.write(ptySessionId, "你好，我是新用户\r");
            } else {
              console.info(`${LOG_PREFIX} Skipped onboarding message: session changed or not running`);
            }
          }, 5000);
        }
      } else {
        console.warn(`${LOG_PREFIX} PTY session created but no active selfChat session`);
      }
    },
    [updatePtySessionId, setStatus]
  );

  const handleSessionExited = useCallback(
    (exitCode: number) => {
      const session = useSelfChatStore.getState().activeSession;
      if (session) {
        console.warn(
          `${LOG_PREFIX} PTY session EXITED: exitCode=${exitCode}, ptySession=${session.ptySessionId}`
        );
        setStatus(session.id, "exited");
      }
    },
    [setStatus]
  );

  // SelfChat 的可见性上报。
  //
  // 它是全屏主视图（MainViewSwitcher 下），切到别的视图时组件仍挂载，此前
  // 硬编码 isActive={true} → 永远自认可见，一个跑着 Claude 的终端从不降档。
  //
  // owner 用 selfChatOwnerId(session.id) 而非 tabId——它根本没有 tab（不在
  // pane 树里）。**退场挂会话结束/切换，不挂 unmount**：terminalKeyRef 自增
  // 会让 TerminalView 重建而外层组件不卸载，挂 unmount 的话旧 owner 条目
  // 永久留在 store，anyVisible 被钉死成 true，那个会话再也不休眠。
  const selfChatSessionId = activeSession?.id;
  // 它是全屏主视图：切到分屏/文件等别的主视图时组件仍挂载但不可见，
  // 光看 document.visibilityState（那是**整个窗口**的）会一直判成可见。
  const isSelfChatView = useActivityBarStore((s) => s.appViewMode) === "selfchat";
  useEffect(() => {
    if (!selfChatSessionId) return;
    const owner = selfChatOwnerId(selfChatSessionId);
    const { reportView, removeOwner } = useTabViewStateStore.getState();

    const sync = () => {
      const windowHidden = document.visibilityState === "hidden";
      const visible = !windowHidden && isSelfChatView;
      reportView(owner, "selfchat", !visible ? "hidden" : document.hasFocus() ? "active" : "visible");
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);

    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      // 会话结束/切换：整个 owner 退场（它只有这一路视图）
      removeOwner(owner);
    };
  }, [selfChatSessionId, isSelfChatView]);

  // 会话存在 → 显示终端
  if (activeSession) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <SelfChatContextBar
          session={activeSession}
          onRestart={handleRestart}
          onEndSession={handleEndSession}
        />
        <div className="flex-1 overflow-hidden">
          <TerminalView
            key={terminalKeyRef.current}
            ref={terminalRef}
            sessionId={activeSession.ptySessionId}
            projectPath={activeSession.appCwd}
            isActive={true}
            visibilityOwnerId={selfChatOwnerId(activeSession.id)}
            viewRole="selfchat"
            launchClaude={true}
            cliTool={defaultCliTool}
            providerId={activeProvider.id}
            modelId={activeProvider.modelId}
            providerSelection={activeProvider.selection}
            skipMcp={false}
            appendSystemPrompt={activeSession.systemPrompt ?? undefined}
            onSessionCreated={handleSessionCreated}
            onSessionExited={handleSessionExited}
          />
        </div>
      </div>
    );
  }

  // 加载中 / 空状态
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <Loader2 className="w-8 h-8 mx-auto text-muted-foreground/60 animate-spin" />
        <p className="text-sm text-muted-foreground">
          {t("selfChat.emptyState")}
        </p>
      </div>
    </div>
  );
}
