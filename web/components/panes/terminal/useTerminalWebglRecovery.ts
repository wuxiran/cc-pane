// Windows WebGL 花屏恢复：DPR 变化/休眠间隙触发的图集清理与渲染器重建。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。ref 全部由调用方持有，
// cleanup() 清理计时器的顺序与原实现一致。
import { useCallback } from "react";
import type { TerminalRendererController } from "../terminalRendererController";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";

const IS_WINDOWS = typeof navigator !== "undefined" && navigator.platform.startsWith("Win");
const WEBGL_RECOVERY_PROMOTION_WINDOW_MS = 12_000;

interface RefValue<T> {
  current: T;
}

export interface TerminalWebglRecoveryRefs {
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  atlasResetTimerRef: RefValue<ReturnType<typeof setTimeout> | null>;
  lastDevicePixelRatioRef: RefValue<number>;
  lastWebglRecoveryAtRef: RefValue<number>;
  webglRecoveryStreakRef: RefValue<number>;
}

export interface UseTerminalWebglRecoveryParams extends TerminalWebglRecoveryRefs {
  isViewActive: () => boolean;
  isRenderVisible: () => boolean;
  leafFocused?: boolean;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

export function useTerminalWebglRecovery({
  rendererControllerRef,
  layoutSchedulerRef,
  atlasResetTimerRef,
  lastDevicePixelRatioRef,
  lastWebglRecoveryAtRef,
  webglRecoveryStreakRef,
  isViewActive,
  isRenderVisible,
  leafFocused,
  debugLog,
}: UseTerminalWebglRecoveryParams) {
  const shouldRunWebglRecovery = useCallback(() => {
    const renderer = rendererControllerRef.current;
    // 焦点类判定：store 的 active 是 tab 级，必须再按 leafFocused 分焦点，
    // 否则分屏多 leaf 同时判获焦、同时跑 WebGL 恢复。
    return Boolean(
      IS_WINDOWS &&
      renderer?.getActiveRenderer() === "webgl" &&
      isViewActive() &&
      (leafFocused ?? true) &&
      isRenderVisible()
    );
  }, [isRenderVisible, isViewActive, leafFocused]);

  const scheduleWebglRecovery = useCallback((reason: string, options: { forceRecreate?: boolean } = {}) => {
    if (!shouldRunWebglRecovery()) return;
    if (atlasResetTimerRef.current) {
      clearTimeout(atlasResetTimerRef.current);
    }
    atlasResetTimerRef.current = setTimeout(() => {
      atlasResetTimerRef.current = null;
      if (!shouldRunWebglRecovery()) return;

      lastDevicePixelRatioRef.current = window.devicePixelRatio;
      const now = Date.now();
      const elapsedSinceRecovery = now - lastWebglRecoveryAtRef.current;
      webglRecoveryStreakRef.current =
        elapsedSinceRecovery <= WEBGL_RECOVERY_PROMOTION_WINDOW_MS
          ? webglRecoveryStreakRef.current + 1
          : 1;
      lastWebglRecoveryAtRef.current = now;

      const controller = rendererControllerRef.current;
      const shouldRecreate = options.forceRecreate || webglRecoveryStreakRef.current >= 3;
      if (shouldRecreate && controller?.recreateWebgl(`webgl.recovery.${reason}`)) {
        debugLog("webgl.renderer.recreate", {
          reason,
          streak: webglRecoveryStreakRef.current,
          forced: Boolean(options.forceRecreate),
          dpr: lastDevicePixelRatioRef.current,
        });
        // 重建成功后清零 streak：否则连续的 resize/focus/visible 事件会让 streak 一直 ≥3、
        // 反复重建 WebGL context（每次重建都新建一个 context），是撞满 ~16 上限的主要推手。
        webglRecoveryStreakRef.current = 0;
        layoutSchedulerRef.current?.schedule(`webgl.renderer.recreate.${reason}`, { force: true });
        return;
      }

      const didClear = controller?.clearTextureAtlas(`webgl.texture-atlas.${reason}`) ?? false;
      debugLog("webgl.texture-atlas.recover", {
        reason,
        didClear,
        streak: webglRecoveryStreakRef.current,
        dpr: lastDevicePixelRatioRef.current,
      });
      layoutSchedulerRef.current?.schedule(`webgl.texture-atlas.${reason}`);
    }, 225);
  }, [debugLog, shouldRunWebglRecovery]);

  return { shouldRunWebglRecovery, scheduleWebglRecovery };
}
