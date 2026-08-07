// 桥接后端 history-updated 事件（resume id 绑定）到前端三个落点（docs/86）：
// 1. ResumeBindingStore 权威镜像（key = ptySessionId，不依赖 tab/leaf 就位）；
// 2. leaf.resumeId 回写（带退避重试 + 耗尽后晚到回填）；
// 3. `cc-panes:history-updated` window 事件（既有页面订阅方式不变）。
//
// 从 useTerminalSessionRestore.ts 抽出（行数棘轮 + 职责独立）；对外入口
// `useTerminalResumeIdBridge` 经原文件 re-export，消费方无感。
import { useEffect } from "react";
import { usePanesStore } from "@/stores";
import { useResumeBindingStore } from "@/stores/useResumeBindingStore";
import { listenIfTauri } from "@/services/runtime";
import { TERMINAL_LAYOUT_CHANGED_EVENT } from "@/lib/paneTree";

// 重试参数：WSL 慢启动下 create_terminal 可超过 40s 才返回（leaf.sessionId
// 才写入），旧的 6 次 ~10.5s 覆盖不到，耗尽即永久丢绑定（DB 有值、快照没有）。
const RESUME_BIND_MAX_ATTEMPTS = 12;
const RESUME_BIND_MAX_DELAY_MS = 5_000;
const RESUME_BIND_PENDING_TTL_MS = 10 * 60_000;

interface PendingResumeBinding {
  resumeSessionId: string;
  resumeSource?: string;
  expiresAt: number;
}

// 重试耗尽后的晚到回填暂存：key = ptySessionId。leaf.sessionId 写入时
// （session.update 布局事件）重放，命中即删。TTL 防会话已死后的泄漏。
const pendingResumeBindings = new Map<string, PendingResumeBinding>();

function replayPendingResumeBindings(): void {
  if (pendingResumeBindings.size === 0) return;
  const now = Date.now();
  for (const [ptySessionId, pending] of pendingResumeBindings) {
    if (pending.expiresAt <= now) {
      pendingResumeBindings.delete(ptySessionId);
      continue;
    }
    const found = usePanesStore.getState().updateTabAgentResumeId(
      ptySessionId,
      pending.resumeSessionId,
      pending.resumeSource,
    );
    if (found) pendingResumeBindings.delete(ptySessionId);
  }
}

// 统一桥接后端发来的 history-updated 事件，保持现有页面订阅方式不变。
export function useTerminalResumeIdBridge(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri<{ ptySessionId?: string; resumeSessionId?: string; resumeSource?: string }>("history-updated", (event) => {
      if (cancelled) return;
      const payload = event.payload ?? {};
      if (payload.ptySessionId && payload.resumeSessionId) {
        // 绑定事件可能早于 create_terminal 返回（tab.sessionId 尚未写入）到达，
        // 未命中 tab 时带退避重试，避免 issued/osc-title 绑定丢失
        const { ptySessionId, resumeSessionId, resumeSource } = payload;
        // 权威镜像先落（key = ptySessionId，不依赖 tab/leaf 就位）：恢复启动
        // 按 savedSessionId 从这里取最新值，快照 leaf.resumeId 只是兼容副本。
        useResumeBindingStore.getState().recordBinding(
          ptySessionId,
          resumeSessionId,
          resumeSource,
        );
        const applyBinding = (attempt: number) => {
          if (cancelled) return;
          const found = usePanesStore.getState().updateTabAgentResumeId(
            ptySessionId,
            resumeSessionId,
            resumeSource,
          );
          if (found) {
            pendingResumeBindings.delete(ptySessionId);
            return;
          }
          if (attempt < RESUME_BIND_MAX_ATTEMPTS) {
            setTimeout(
              () => applyBinding(attempt + 1),
              Math.min(500 * (attempt + 1), RESUME_BIND_MAX_DELAY_MS),
            );
            return;
          }
          // 耗尽不丢：挂进晚到回填表，等 leaf.sessionId 写入时重放。
          console.warn(
            "[ResumeBind] retries exhausted; queued for late backfill",
            { ptySessionId, resumeSessionId, resumeSource },
          );
          pendingResumeBindings.set(ptySessionId, {
            resumeSessionId,
            resumeSource,
            expiresAt: Date.now() + RESUME_BIND_PENDING_TTL_MS,
          });
        };
        applyBinding(0);
      }
      window.dispatchEvent(new CustomEvent("cc-panes:history-updated"));
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    const onLayoutChanged = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      if (reason === "session.update") replayPendingResumeBindings();
    };
    window.addEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, onLayoutChanged);
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, onLayoutChanged);
    };
  }, []);
}
