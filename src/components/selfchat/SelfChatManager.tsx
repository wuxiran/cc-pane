import { useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { TerminalView } from "@/components/panes";
import type { TerminalViewHandle } from "@/components/panes";
import SelfChatContextBar from "./SelfChatContextBar";
import { useSelfChatStore, useTerminalStatusStore } from "@/stores";
import { selfChatService, terminalService } from "@/services";

const LOG_PREFIX = "[SelfChat]";

export default function SelfChatManager() {
  const { t } = useTranslation("common");

  const activeSession = useSelfChatStore((s) => s.activeSession);
  const startSession = useSelfChatStore((s) => s.startSession);
  const updatePtySessionId = useSelfChatStore((s) => s.updatePtySessionId);
  const setStatus = useSelfChatStore((s) => s.setStatus);
  const setContextInjected = useSelfChatStore((s) => s.setContextInjected);
  const endSession = useSelfChatStore((s) => s.endSession);

  const terminalRef = useRef<TerminalViewHandle>(null);
  const injectionAttemptedRef = useRef<string | null>(null);
  const autoStartedRef = useRef(false);
  const terminalKeyRef = useRef(0);

  // 自动启动：进入 selfchat 模式时自动获取 appCwd 并启动会话
  useEffect(() => {
    if (activeSession || autoStartedRef.current) return;
    autoStartedRef.current = true;

    console.info(`${LOG_PREFIX} Auto-starting: fetching app CWD...`);
    selfChatService.getAppCwd().then((cwd) => {
      // 再次检查避免竞争
      if (useSelfChatStore.getState().activeSession) {
        console.warn(`${LOG_PREFIX} Race condition: session already exists, skipping start`);
        return;
      }
      console.info(`${LOG_PREFIX} Starting session, appCwd=${cwd}`);
      startSession(cwd);
      terminalKeyRef.current += 1;
    }).catch((err) => {
      console.error(`${LOG_PREFIX} FAILED to get app CWD:`, err);
      autoStartedRef.current = false;
    });
  }, [activeSession, startSession]);

  // 监听终端 waitingInput 状态并注入上下文
  const getStatus = useTerminalStatusStore((s) => s.getStatus);

  useEffect(() => {
    if (!activeSession) return;
    if (activeSession.contextInjected) return;
    if (activeSession.status !== "running") return;
    if (!activeSession.ptySessionId) return;
    if (injectionAttemptedRef.current === activeSession.id) return;

    const status = getStatus(activeSession.ptySessionId);
    if (status === "waitingInput") {
      console.info(
        `${LOG_PREFIX} WaitingInput detected via status poll, ptySession=${activeSession.ptySessionId}`
      );
      injectionAttemptedRef.current = activeSession.id;
      injectContext(activeSession.id, activeSession.ptySessionId);
    }
  });

  // Fallback: 5 秒超时自动注入
  useEffect(() => {
    if (!activeSession) return;
    if (activeSession.contextInjected) return;
    if (activeSession.status !== "running") return;
    if (!activeSession.ptySessionId) return;
    if (injectionAttemptedRef.current === activeSession.id) return;

    const timer = setTimeout(() => {
      if (injectionAttemptedRef.current === activeSession.id) return;
      console.warn(
        `${LOG_PREFIX} 5s timeout fallback: injecting context without WaitingInput, ptySession=${activeSession.ptySessionId}`
      );
      injectionAttemptedRef.current = activeSession.id;
      injectContext(activeSession.id, activeSession.ptySessionId!);
    }, 5000);

    return () => clearTimeout(timer);
  }, [activeSession?.id, activeSession?.status, activeSession?.ptySessionId, activeSession?.contextInjected]);

  const injectContext = useCallback(
    async (sessionId: string, ptySessionId: string) => {
      const session = useSelfChatStore.getState().activeSession;
      if (!session || session.id !== sessionId) {
        console.warn(`${LOG_PREFIX} injectContext: session mismatch or missing, aborting`);
        return;
      }

      console.info(`${LOG_PREFIX} Collecting app context for injection...`);
      try {
        const prompt = await selfChatService.collectAppContext();
        console.info(`${LOG_PREFIX} Context collected (${prompt.length} chars), writing to PTY...`);
        await terminalService.write(ptySessionId, prompt + "\n");
        console.info(`${LOG_PREFIX} Context injected successfully, ptySession=${ptySessionId}`);
        setContextInjected(sessionId);
      } catch (err) {
        console.error(`${LOG_PREFIX} Context injection FAILED:`, err);
      }
    },
    [setContextInjected]
  );

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
    injectionAttemptedRef.current = null;
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
          `${LOG_PREFIX} PTY session EXITED: exitCode=${exitCode}, ptySession=${session.ptySessionId}, contextInjected=${session.contextInjected}`
        );
        setStatus(session.id, "exited");
      }
    },
    [setStatus]
  );

  const handleReinject = useCallback(() => {
    if (!activeSession?.ptySessionId) return;
    console.info(`${LOG_PREFIX} Re-inject requested, ptySession=${activeSession.ptySessionId}`);
    injectionAttemptedRef.current = null;
    const session = useSelfChatStore.getState().activeSession;
    if (session) {
      useSelfChatStore.setState({
        activeSession: { ...session, contextInjected: false },
      });
      injectContext(session.id, session.ptySessionId!);
    }
  }, [activeSession?.ptySessionId, injectContext]);

  // 会话存在 → 显示终端
  if (activeSession) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <SelfChatContextBar
          session={activeSession}
          onReinject={handleReinject}
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
            launchClaude={true}
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
