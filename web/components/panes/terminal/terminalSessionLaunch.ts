// 后端会话创建/挂接：冷恢复回放、attach 既有会话、restore 队列化创建、
// 失败降级文案。从 TerminalView.tsx 的 init effect 拆出（纯代码移动，逻辑不变）。
import type { Terminal } from "@xterm/xterm";
import { sessionRestoreService, terminalService, getRecoverySnapshot } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { getErrorMessage, toTerminalLaunchError } from "@/utils";
import { usePanesStore } from "@/stores";
import { waitForTerminalRestoreBarrierWithDeadline } from "@/services/terminalRestoreBarrier";
import type { TerminalSlotHolder } from "@/lib/terminalSlot";
import type { HibernatedTerminalState } from "../terminalHibernation";
import {
  clearColdReplayOutputOnFailure,
  pickCreateSessionResumeId,
  replayColdRestoreOutput,
} from "../terminalResume";
import { replayAttachOrWake } from "../useTerminalHibernation";
import { describeTerminalInitError } from "../terminalInitError";
import { startLaunchBackfillIfNeeded } from "../terminalLaunchBackfill";
import { resolveCliTool, resolveLaunchId, resolveRuntimeKind } from "../terminalLaunchIdentity";
import {
  createRestoreLaunchCancelledError,
  isRestoreLaunchCancelled,
  terminalRestoreLaunchQueue,
} from "../terminalRestoreQueue";
import { syncTerminalGeometry } from "../terminalSessionGeometry";
import { withTerminalReplayPresentation } from "../terminalReplayPresentation";
import { findLiveSavedSessionId } from "../terminalViewHelpers";
import type { RestoreLaunchState } from "../terminalRestoreQueue";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";
import type { TerminalViewProps } from "./terminalViewTypes";

interface RefValue<T> {
  current: T;
}

export interface LaunchTerminalSessionDeps {
  props: TerminalViewProps;
  term: Terminal;
  slot: TerminalSlotHolder;
  isMounted: () => boolean;
  initGeometryEpoch: number;
  drivesBackendPty: boolean;
  currentSessionIdRef: RefValue<string | null>;
  wakeStateRef: RefValue<HibernatedTerminalState | null>;
  geometryEpochRef: RefValue<number>;
  readOnlyRef: RefValue<boolean>;
  resizeBackendPtyRef: RefValue<boolean>;
  isSshRef: RefValue<boolean>;
  onReconnectRef: RefValue<(() => Promise<string | null>) | undefined>;
  onSessionCreatedRef: RefValue<(sessionId: string) => void>;
  onLaunchErrorRef: RefValue<((error: ReturnType<typeof toTerminalLaunchError>) => void) | undefined>;
  restoreLaunchStartedRef: RefValue<boolean>;
  deferredRestoreRef: RefValue<boolean>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  logRestoreEvent: (event: string, extra?: Record<string, unknown>) => void;
  reportRestoreLaunchState: (state: RestoreLaunchState) => void;
  renderTerminalData: (data: string) => string;
  renderCheckpointData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  bindSessionCallbacks: (sessionId: string) => Promise<void>;
  unbindSessionCallbacks: () => void;
  /** 创建竞态回滚杀点（本体在白名单文件 TerminalView.tsx，注入至此）。 */
  killDuplicateSessionAfterCreate: (sessionId: string) => Promise<void>;
  killSessionOnUnmounted: (sessionId: string) => void;
}

/** Create a new backend session or attach to an existing one. */
export async function launchOrAttachTerminalSession({
  props,
  term,
  slot,
  isMounted,
  initGeometryEpoch,
  drivesBackendPty,
  currentSessionIdRef,
  wakeStateRef,
  geometryEpochRef,
  readOnlyRef,
  resizeBackendPtyRef,
  isSshRef,
  onReconnectRef,
  onSessionCreatedRef,
  onLaunchErrorRef,
  restoreLaunchStartedRef,
  deferredRestoreRef,
  layoutSchedulerRef,
  debugLog,
  logRestoreEvent,
  reportRestoreLaunchState,
  renderTerminalData,
  renderCheckpointData,
  writeTerminalData,
  syncTrackedBufferType,
  bindSessionCallbacks,
  unbindSessionCallbacks,
  killDuplicateSessionAfterCreate,
  killSessionOnUnmounted,
}: LaunchTerminalSessionDeps): Promise<void> {
  if (props.projectPath) {
    try {
      if (props.restoring) logRestoreEvent("init.listeners.begin");
      await ensureListeners();
      if (props.restoring) logRestoreEvent("init.listeners.end");

      if (props.restoring) {
        logRestoreEvent("init.saved-session-lookup.begin", {
          savedSessionId: props.savedSessionId ?? null,
        });
      }
      const liveSavedSessionId = props.sessionId
        ? null
        : await findLiveSavedSessionId(props.restoring ? props.savedSessionId : undefined);
      if (props.restoring) {
        logRestoreEvent("init.saved-session-lookup.end", {
          liveSavedSessionId: liveSavedSessionId ?? null,
        });
      }

      // Replay persisted output before deciding whether to create a live PTY.
      // (Restored tabs still start their live PTY on first app restore even when
      // hidden, otherwise background tabs can remain stuck on the restore overlay.)
      if (props.restoring && props.savedSessionId && !liveSavedSessionId) {
        await withTerminalReplayPresentation(term, async () => {
          await replayColdRestoreOutput(term, props.savedSessionId!, logRestoreEvent, debugLog, renderCheckpointData);
          // writeln queues parsing; keep the static frame until the final write callback.
          await new Promise<void>((resolve) => term.write("", resolve));
        });
      }

      let sessionId: string;
      let effectiveResumeId = pickCreateSessionResumeId(props);
      // 休眠唤醒：优先回放休眠容器（全量历史，超出后端 8MB 窗口也不丢）。
      const wake = wakeStateRef.current;
      wakeStateRef.current = null;
      const attachSessionId = wake?.sessionId ?? props.sessionId ?? liveSavedSessionId;

      if (attachSessionId) {
        if (props.restoring) {
          logRestoreEvent("init.attach.begin", { sessionId: attachSessionId });
        }
        debugLog("session.attach-existing", {
          attachSessionId,
          source: props.sessionId ? "prop-session-id" : "live-saved-session",
          note: "reusing existing PTY session with replay snapshot when available",
        });
        console.info(`[TerminalView] Reconnecting to existing session: ${attachSessionId}`);
        sessionId = attachSessionId;
        try {
          await replayAttachOrWake({
            canWrite: isMounted,
            term,
            sessionId,
            wake,
            getRecoverySnapshot: (id) => getRecoverySnapshot(id),
            renderTerminalData,
            renderCheckpointData,
            writeTerminalData,
            syncTrackedBufferType,
            showReconnectHint: Boolean(isSshRef.current && onReconnectRef.current),
            debugLog,
          });
        } catch (error) {
          if (props.restoring) {
            logRestoreEvent("init.attach-replay.failed", {
              sessionId: attachSessionId,
              error: getErrorMessage(error),
            });
          }
          debugLog("session.attach-existing.replay.fail", {
            attachSessionId,
            error: getErrorMessage(error),
          });
        }
        if (props.restoring) {
          logRestoreEvent("init.attach.end", { sessionId: attachSessionId });
        }
      } else {
        if (props.layoutActive === false) {
          deferredRestoreRef.current = true;
          reportRestoreLaunchState(props.restoring ? "queued" : "idle");
          debugLog("session.create.deferred-layout-hidden", {
            restoring: props.restoring ?? false,
          });
          logRestoreEvent("init.deferred-layout-hidden");
          return;
        }

        // Init effect owns this terminal's restore (current/active layout); mark it
        // so the activation fallback below never double-launches the same tab.
        restoreLaunchStartedRef.current = true;

        // Create a brand-new backend session. Resume id comes only from the
        // tab/snapshot/props chain (never directory-level launch history).
        const cliTool = resolveCliTool(props.cliTool, props.launchClaude);
        const runtimeKind = resolveRuntimeKind(props.ssh, props.wsl);

        console.info(
          `[TerminalView] Creating new session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, resumeId=${effectiveResumeId ?? "none"}`
        );
        const backfillStartTime = new Date().toISOString();
        let createdLaunchId: string | undefined;
        debugLog("session.create.begin", {
          resumeId: effectiveResumeId ?? null,
        });
        const launchSession = async () => {
          if (props.restoring) logRestoreEvent("init.restore-barrier.begin");
          await waitForTerminalRestoreBarrierWithDeadline();
          if (props.restoring) logRestoreEvent("init.restore-barrier.end");
          if (
            props.tabId
            && props.paneId
            && !usePanesStore.getState().canCreateTerminalSession(
              props.tabId,
              props.paneId,
              props.restoring ? props.savedSessionId : undefined,
            )
          ) {
            throw createRestoreLaunchCancelledError();
          }
          if (!slot.acquire(props.tabId, props.paneId)) {
            debugLog("session.create.cancelled-slot-in-flight", {});
            throw createRestoreLaunchCancelledError();
          }
          const originLayoutId = props.tabId
            ? usePanesStore.getState().findTabAcrossLayouts(props.tabId)?.layoutId
            : undefined;
          createdLaunchId = resolveLaunchId({
            launchId: props.launchId,
            restoring: props.restoring,
            // restoring 标志与 savedSessionId 不总同步（快照落盘时 leaf 已
            // 退出的场景 restoring 为 falsy）；漏传会复用旧 launchId，
            // bind_pty_session 必然落空（docs/69）。
            savedSessionId: props.savedSessionId,
            launchAttempt: props.launchAttempt,
          });
          if (props.tabId && props.paneId) {
            usePanesStore.getState().updateTerminalLaunchId(
              props.tabId,
              props.paneId,
              createdLaunchId,
            );
          }
          return terminalService.createSession({
            launchId: createdLaunchId,
            projectPath: props.projectPath,
            cols: term.cols,
            rows: term.rows,
            workspaceName: props.workspaceName,
            providerId: props.providerId,
            modelId: props.modelId,
            providerSelection: props.providerSelection,
            launchProfileId: props.launchProfileId,
            workspacePath: props.workspacePath,
            workspaceSnapshotId: props.workspaceSnapshotId,
            launchClaude: props.launchClaude,
            cliTool: props.cliTool,
            resumeId: effectiveResumeId,
            skipMcp: props.skipMcp,
            appendSystemPrompt: props.appendSystemPrompt,
            // restore 路径不重放 initialPrompt（原会话已消费过）
            initialPrompt: props.restoring ? undefined : props.initialPrompt,
            yoloMode: props.yoloMode,
            adapterOptions: props.adapterOptions,
            ssh: props.ssh,
            wsl: props.wsl,
            originLayoutId,
            originTabId: props.tabId,
            originTerminalPaneId: props.paneId,
            expectedSavedSessionId: props.restoring ? props.savedSessionId : undefined,
          });
        };
        sessionId = props.restoring
          ? await terminalRestoreLaunchQueue.run(launchSession, {
              isCancelled: () => !isMounted(),
              onState: reportRestoreLaunchState,
            })
          : await launchSession();
        if (
          props.tabId
          && props.paneId
          && !usePanesStore.getState().canCreateTerminalSession(
            props.tabId,
            props.paneId,
            props.restoring ? props.savedSessionId : undefined,
            Boolean(props.restoring && sessionId === props.savedSessionId),
          )
        ) {
          if (sessionId !== props.savedSessionId) {
            await killDuplicateSessionAfterCreate(sessionId);
          }
          if (props.restoring) {
            logRestoreEvent("init.create.cancelled-after-create", {
              sessionId,
              killedDuplicate: sessionId !== props.savedSessionId,
            });
          }
          throw createRestoreLaunchCancelledError();
        }
        slot.release();
        reportRestoreLaunchState("idle");
        if (props.restoring) {
          logRestoreEvent("init.create.end", {
            sessionId,
            reusedExpected: sessionId === props.savedSessionId,
          });
        }
        debugLog("session.create.end", {
          createdSessionId: sessionId,
        });
        console.info(`[TerminalView] Session created: ${sessionId}`);
        startLaunchBackfillIfNeeded({
          createdLaunchId,
          sessionId,
          cliTool,
          runtimeKind,
          projectPath: props.projectPath,
          workspacePath: props.workspacePath,
          wsl: props.wsl,
          backfillStartTime,
        });
      }

      if (!isMounted()) {
        if (!attachSessionId && sessionId !== props.savedSessionId) {
          console.warn(`[TerminalView] Component unmounted during init, killing session: ${sessionId}`);
          killSessionOnUnmounted(sessionId);
        }
        return;
      }

      currentSessionIdRef.current = sessionId;
      debugLog("session.current.updated", {
        currentSessionId: sessionId,
      });

      if (!props.sessionId) {
        onSessionCreatedRef.current(sessionId);
        // Persist the corrected resume id back into the tab state.
        if (effectiveResumeId && effectiveResumeId !== props.resumeId) {
          usePanesStore.getState().updateTabAgentResumeId(sessionId, effectiveResumeId);
        }
        // initialPrompt 已随本次 createSession 消费，清除防 restore/reattach 重放
        if (props.initialPrompt && props.tabId) {
          usePanesStore.getState().clearTabInitialPrompt(props.tabId);
        }
      }

      // Clear restore metadata once the live session is ready.
      if (props.restoring && props.paneId && props.tabId) {
        usePanesStore.getState().clearRestoring(props.paneId ?? "", props.tabId, props.paneId);
        if (props.savedSessionId) {
          sessionRestoreService.clearOutput(props.savedSessionId).catch(console.error);
        }
      }
      syncTerminalGeometry(sessionId, term, layoutSchedulerRef, drivesBackendPty || resizeBackendPtyRef.current, readOnlyRef.current && !resizeBackendPtyRef.current, attachSessionId ? "session.attach" : "session.create", () => geometryEpochRef.current === initGeometryEpoch);
      // Register output and exit handlers.
      await bindSessionCallbacks(sessionId);
      if (!isMounted()) {
        unbindSessionCallbacks();
        return;
      }
    } catch (error) {
      slot.release();
      if (!isMounted()) return;
      if (isRestoreLaunchCancelled(error)) {
        deferredRestoreRef.current = true;
        restoreLaunchStartedRef.current = false;
        reportRestoreLaunchState("idle");
        logRestoreEvent("init.create.cancelled");
        return;
      }
      if (props.restoring) {
        reportRestoreLaunchState("failed");
        logRestoreEvent("init.failed", { error: getErrorMessage(error) });
        clearColdReplayOutputOnFailure(
          props.savedSessionId, logRestoreEvent, "init.output-cleared-on-failure",
        );
      }
      const failedAttachSessionId = props.sessionId ?? (
        props.restoring ? props.savedSessionId : undefined
      );
      if (failedAttachSessionId) {
        void terminalService.releaseSession(failedAttachSessionId).catch((releaseError) => {
          console.warn("[TerminalView] Failed to release session after attach error:", releaseError);
        });
      }
      onLaunchErrorRef.current?.(toTerminalLaunchError(error));
      console.error(
        `[TerminalView] FAILED to init session: project=${props.projectPath}, launchClaude=${props.launchClaude ?? false}, error=`,
        error
      );
      // 文案三级降级（结构化错误码 / CLI 未安装 / 通用）在 terminalInitError。
      for (const line of describeTerminalInitError(getErrorMessage(error))) {
        term.writeln(line);
      }
    }
  }
}
