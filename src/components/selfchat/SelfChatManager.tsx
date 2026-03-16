import { useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { TerminalView } from "@/components/panes";
import type { TerminalViewHandle } from "@/components/panes";
import SelfChatContextBar from "./SelfChatContextBar";
import { useSelfChatStore, useSettingsStore, usePanesStore } from "@/stores";
import { selfChatService, terminalService } from "@/services";

const LOG_PREFIX = "[SelfChat]";

export default function SelfChatManager() {
  const { t } = useTranslation("common");

  const defaultCliTool = useSettingsStore((s) => s.settings?.general.defaultCliTool ?? "claude");
  // 从当前活跃 Tab 继承 providerId（SelfChat 无自身 provider 配置）
  const activeProviderId = usePanesStore((s) => {
    const pane = s.rootPane;
    if (pane.type === "panel") {
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
      return tab?.providerId;
    }
    return undefined;
  });
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
            launchClaude={true}
            cliTool={defaultCliTool}
            providerId={activeProviderId}
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
