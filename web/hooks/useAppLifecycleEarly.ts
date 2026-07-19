// MainApp 早段生命周期 effects（从 App.tsx 原样搬出，勿在此做行为改动）。
// 与 useAppLifecycleLate 的调用顺序共同保持原 App.tsx 中 effect 的注册顺序，
// 调整顺序前必须先证明顺序无关。
import { useEffect } from "react";
import { invokeIfTauri, isTauriRuntime, listenIfTauri, listenWebviewIfTauri } from "@/services/runtime";
import { waitForDesktopRuntime } from "@/utils/desktopRuntime";
import { playNotificationSound } from "@/utils/notificationSound";
import { registerGlobalApi } from "@/utils/globalApi";

export function useAppLifecycleEarly(): void {
  // 后端桌面通知成功发出时，播放应用内提示音补足系统通知静音场景。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    if (!isTauriRuntime()) return;
    waitForDesktopRuntime().then(async (ready) => {
      if (!ready || cancelled) return;
      const cleanup = await listenIfTauri("notification-sent", () => {
        playNotificationSound().catch((error) => {
          console.warn("Notification sound failed:", error);
        });
      });
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    }).catch((error) => {
      console.warn("Notification sound listener failed:", error);
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 注册全局 API（Skill 用）
  useEffect(() => {
    registerGlobalApi();
  }, []);

  // 保留 terminal-exit 的 Spec 收尾链路；历史卡片回填已迁到后端，不再在这里处理。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenWebviewIfTauri<{ sessionId: string }>("terminal-exit", async (event) => {
      if (cancelled) return;
      invokeIfTauri("handle_terminal_exit_spec_by_session", {
        sessionId: event.payload.sessionId,
      }).catch((err: unknown) => console.warn("Spec exit handling failed:", err));
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
