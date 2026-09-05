// 激活兜底：布局翻活时 refit，并为隐藏挂载的恢复标签补建延迟 PTY。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。effect 依赖与原实现逐项一致。
import { useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { sessionRestoreService, terminalService, getRecoverySnapshot } from "@/services";
import { ensureListeners } from "@/services/terminalService";
import { getErrorMessage, toTerminalLaunchError } from "@/utils";
import { usePanesStore } from "@/stores";
import { waitForTerminalRestoreBarrierWithDeadline } from "@/services/terminalRestoreBarrier";
import { createTerminalSlotHolder } from "@/lib/terminalSlot";
import { pickCreateSessionResumeId } from "../terminalResume";
import { replayAttachedSession } from "../terminalReplay";
import { startLaunchBackfillIfNeeded } from "../terminalLaunchBackfill";
import { resolveCliTool, resolveLaunchId, resolveRuntimeKind } from "../terminalLaunchIdentity";
import { clearColdReplayOutputOnFailure } from "../terminalResume";
import {
  createRestoreLaunchCancelledError,
  isRestoreLaunchCancelled,
  terminalRestoreLaunchQueue,
} from "../terminalRestoreQueue";
import { syncTerminalGeometry } from "../terminalSessionGeometry";
import { findLiveSavedSessionId } from "../terminalViewHelpers";
import type { RestoreLaunchState } from "../terminalRestoreQueue";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";
import type { TerminalViewProps } from "./terminalViewTypes";

interface RefValue<T> {
  current: T;
}

export interface UseTerminalDeferredRestoreParams {
  props: TerminalViewProps;
  terminalReady: boolean;
  drivesBackendPty: boolean;
  terminalInstanceRef: RefValue<Terminal | null>;
  fitAddonRef: RefValue<FitAddon | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  currentSessionIdRef: RefValue<string | null>;
  deferredRestoreRef: RefValue<boolean>;
  everHiddenRef: RefValue<boolean>;
  restoreLaunchStartedRef: RefValue<boolean>;
  isUnmountedRef: RefValue<boolean>;
  geometryEpochRef: RefValue<number>;
  trackedBufferTypeRef: RefValue<"unknown" | "normal" | "alternate">;
  readOnlyRef: RefValue<boolean>;
  resizeBackendPtyRef: RefValue<boolean>;
  onSessionCreatedRef: RefValue<(sessionId: string) => void>;
  onLaunchErrorRef: RefValue<((error: ReturnType<typeof toTerminalLaunchError>) => void) | undefined>;
  isRenderVisible: () => boolean;
  isViewActive: () => boolean;
  renderTerminalData: (data: string) => string;
  renderCheckpointData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  bindSessionCallbacks: (sessionId: string) => Promise<void>;
  unbindSessionCallbacks: () => void;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  logRestoreEvent: (event: string, extra?: Record<string, unknown>) => void;
  reportRestoreLaunchState: (state: RestoreLaunchState) => void;
  /** 创建竞态回滚杀点（本体在白名单文件 TerminalView.tsx，注入至此）。 */
  killDuplicateSessionAfterCreate: (sessionId: string) => Promise<void>;
  killSessionOnUnmounted: (sessionId: string) => void;
}

/** Refit on activation and create deferred PTYs for restored tabs. */
export function useTerminalDeferredRestore({
  props,
  terminalReady,
  drivesBackendPty,
  terminalInstanceRef,
  fitAddonRef,
  layoutSchedulerRef,
  currentSessionIdRef,
  deferredRestoreRef,
  everHiddenRef,
  restoreLaunchStartedRef,
  isUnmountedRef,
  geometryEpochRef,
  trackedBufferTypeRef,
  readOnlyRef,
  resizeBackendPtyRef,
  onSessionCreatedRef,
  onLaunchErrorRef,
  isRenderVisible,
  isViewActive,
  renderTerminalData,
  renderCheckpointData,
  writeTerminalData,
  syncTrackedBufferType,
  bindSessionCallbacks,
  unbindSessionCallbacks,
  debugLog,
  logRestoreEvent,
  reportRestoreLaunchState,
  killDuplicateSessionAfterCreate,
  killSessionOnUnmounted,
}: UseTerminalDeferredRestoreParams): void {
  useEffect(() => {
    debugLog("active.effect", {
      deferredRestore: deferredRestoreRef.current,
      trackedBuffer: trackedBufferTypeRef.current,
    });

    const explicitLayoutFit = props.layoutFitKey !== undefined && props.layoutActive !== false;
    const scheduleRefit = () => {
      layoutSchedulerRef.current?.schedule("active.refit", {
        // 焦点抢占：tab 级 active 还要按 leaf 分焦点，避免分屏多 leaf 同帧互抢。
        focusIfSafe: !explicitLayoutFit && isViewActive() && (props.leafFocused ?? true),
        // 可见非焦点允许：分屏另一格可见时 refit，隐藏格子不放行。
        allowInactive: explicitLayoutFit || isRenderVisible(), force: explicitLayoutFit,
      });
    };

    // Create the deferred PTY once the layout is active. This covers terminals that
    // were mounted while their layout was hidden (non-current layouts), whose restore
    // is intentionally deferred until the layout is switched to. `everHiddenRef` is a
    // robust hand-off signal (set purely from layoutActive) so this fires even if the
    // init effect did not reach its defer branch; `restoreLaunchStartedRef` + the live
    // session check prevent double-launching a tab the init effect already owns.
    const needsDeferredRestore =
      (props.layoutActive ?? true) &&
      !currentSessionIdRef.current &&
      !restoreLaunchStartedRef.current &&
      (deferredRestoreRef.current || (everHiddenRef.current && props.restoring === true));
    if (!currentSessionIdRef.current && (everHiddenRef.current || deferredRestoreRef.current || props.restoring)) {
      logRestoreEvent("activation.effect", { needsDeferredRestore });
    }
    if (needsDeferredRestore) {
      if (!props.projectPath || !terminalReady) return;
      const term = terminalInstanceRef.current;
      if (!term) return;

      restoreLaunchStartedRef.current = true;
      deferredRestoreRef.current = false;

      // Session recovery cannot depend on fit succeeding. Hidden tabs use
      // display:none, so layout scheduling may legitimately skip them.
      // 同 init 路径的创建槽位（docs/78 批4）；两条路径共用同一把 (tabId, paneId) 锁。
      const slot = createTerminalSlotHolder(); const initGeometryEpoch = geometryEpochRef.current;
      void (async () => {
          try {
            await ensureListeners();

            const cliTool = resolveCliTool(props.cliTool, props.launchClaude);
            const runtimeKind = resolveRuntimeKind(props.ssh, props.wsl);
            const effectiveResumeId = pickCreateSessionResumeId(props);

            if (isUnmountedRef.current) return;

            const liveSavedSessionId = await findLiveSavedSessionId(props.savedSessionId);
            if (liveSavedSessionId) {
              currentSessionIdRef.current = liveSavedSessionId;
              debugLog("session.deferred-restore.attach-existing", {
                attachSessionId: liveSavedSessionId,
              });
              reportRestoreLaunchState("idle");
              onSessionCreatedRef.current(liveSavedSessionId);
              await replayAttachedSession({
                term,
                sessionId: liveSavedSessionId,
                getRecoverySnapshot: (attachSessionId) => getRecoverySnapshot(attachSessionId),
                writeData: (data) => {
                  const renderedData = renderTerminalData(data);
                  return renderedData ? writeTerminalData(renderedData) : Promise.resolve();
                },
                writeCheckpointData: (data) => writeTerminalData(renderCheckpointData(data)),
                syncTrackedBufferType,
                debugLog,
              });
              if (props.paneId && props.tabId) {
                usePanesStore.getState().clearRestoring(props.paneId ?? "", props.tabId, props.paneId);
                sessionRestoreService.clearOutput(liveSavedSessionId).catch(console.error);
              }
              syncTerminalGeometry(liveSavedSessionId, term, layoutSchedulerRef, drivesBackendPty || resizeBackendPtyRef.current, readOnlyRef.current && !resizeBackendPtyRef.current, "session.deferred-restore.attach", () => geometryEpochRef.current === initGeometryEpoch);
              await bindSessionCallbacks(liveSavedSessionId);
              if (isUnmountedRef.current) {
                unbindSessionCallbacks();
                return;
              }
              return;
            }

            debugLog("session.deferred-restore.begin", {
              resumeId: effectiveResumeId ?? null,
            });
            logRestoreEvent("activation.create.begin", { resumeId: effectiveResumeId ?? null });
            console.info(`[TerminalView] Deferred restore: creating PTY for ${props.projectPath}`);
            const backfillStartTime = new Date().toISOString();
            let createdLaunchId: string | undefined;
            const launchSession = async () => {
              logRestoreEvent("activation.restore-barrier.begin");
              await waitForTerminalRestoreBarrierWithDeadline();
              logRestoreEvent("activation.restore-barrier.end");
              if (
                props.tabId
                && props.paneId
                && !usePanesStore.getState().canCreateTerminalSession(
                  props.tabId,
                  props.paneId,
                  props.savedSessionId,
                )
              ) {
                throw createRestoreLaunchCancelledError();
              }
              if (!slot.acquire(props.tabId, props.paneId)) {
                debugLog("session.deferred-restore.cancelled-slot-in-flight", {});
                throw createRestoreLaunchCancelledError();
              }
              const originLayoutId = props.tabId
                ? usePanesStore.getState().findTabAcrossLayouts(props.tabId)?.layoutId
                : undefined;
              createdLaunchId = resolveLaunchId({
                launchId: props.launchId,
                forceNew: true,
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
                // deferred restore 是恢复路径：不携带 initialPrompt（防重放）
                yoloMode: props.yoloMode,
                adapterOptions: props.adapterOptions,
                ssh: props.ssh,
                wsl: props.wsl,
                originLayoutId,
                originTabId: props.tabId,
                originTerminalPaneId: props.paneId,
                expectedSavedSessionId: props.savedSessionId,
              });
            };
            const sessionId = await terminalRestoreLaunchQueue.run(launchSession, {
              // Once queued, switching layouts must not strand this pane again.
              isCancelled: () => isUnmountedRef.current,
              onState: reportRestoreLaunchState,
            });
            if (
              props.tabId
              && props.paneId
              && !usePanesStore.getState().canCreateTerminalSession(
                props.tabId,
                props.paneId,
                props.savedSessionId,
                sessionId === props.savedSessionId,
              )
            ) {
              if (sessionId !== props.savedSessionId) {
                await killDuplicateSessionAfterCreate(sessionId);
              }
              throw createRestoreLaunchCancelledError();
            }
            slot.release();
            reportRestoreLaunchState("idle");

            if (isUnmountedRef.current) {
              if (sessionId !== props.savedSessionId) {
                killSessionOnUnmounted(sessionId);
              }
              return;
            }

            currentSessionIdRef.current = sessionId;
            debugLog("session.deferred-restore.end", {
              createdSessionId: sessionId,
            });
            logRestoreEvent("activation.create.end", { createdSessionId: sessionId });
            onSessionCreatedRef.current(sessionId);
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

            // Clear restoring state once the deferred session is live.
            if (props.paneId && props.tabId) {
              usePanesStore.getState().clearRestoring(props.paneId ?? "", props.tabId, props.paneId);
              if (props.savedSessionId) {
                sessionRestoreService.clearOutput(props.savedSessionId).catch(console.error);
              }
            }
            syncTerminalGeometry(sessionId, term, layoutSchedulerRef, drivesBackendPty || resizeBackendPtyRef.current, readOnlyRef.current && !resizeBackendPtyRef.current, "session.deferred-restore.create", () => geometryEpochRef.current === initGeometryEpoch);
            await bindSessionCallbacks(sessionId);
            if (isUnmountedRef.current) {
              unbindSessionCallbacks();
              return;
            }
          } catch (err) {
            slot.release();
            if (isUnmountedRef.current) return;
            if (isRestoreLaunchCancelled(err)) {
              deferredRestoreRef.current = true;
              restoreLaunchStartedRef.current = false;
              logRestoreEvent("activation.create.cancelled");
              reportRestoreLaunchState("idle");
              return;
            }
            restoreLaunchStartedRef.current = false;
            reportRestoreLaunchState("failed");
            clearColdReplayOutputOnFailure(
              props.savedSessionId, logRestoreEvent, "activation.output-cleared-on-failure",
            );
            onLaunchErrorRef.current?.(toTerminalLaunchError(err));
            logRestoreEvent("activation.create.failed", { error: getErrorMessage(err) });
            console.error("[TerminalView] Deferred restore failed:", err);
            term.writeln(`\x1b[31m--- Failed to restore session: ${getErrorMessage(err)} ---\x1b[0m`);
          } finally {
            // 同 init 路径：提前 return 也必须释放（见那边的注释）。
            slot.release();
          }
      })();

      return () => {
        // 同 init 路径：create 永不落定时 finally 不执行，槽位只能在这里收。
        slot.release();
        layoutSchedulerRef.current?.cancel();
      };
    }

    if ((isRenderVisible() || explicitLayoutFit) && fitAddonRef.current) {
      scheduleRefit();
      return () => layoutSchedulerRef.current?.cancel();
    }
    // 依赖是「本 tab 的 props 侧信号」；store 侧的可见性翻转由单视图边沿
    // 订阅补 refit，不需要（也无法）进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layoutActive, props.layoutFitKey, props.leafFocused, terminalReady]);
}
