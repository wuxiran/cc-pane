import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Resume 身份绑定的前端权威镜像（docs/86，评审决议「必修4」）。
 *
 * # 为什么要独立成 store
 *
 * resume id 此前存在三份互相追赶的数据里：DB（launch_history，权威）、
 * 布局快照 leaf.resumeId（持久化副本）、内存 leaf（活值）。快照落盘时机、
 * 跨端 5s 轮询整树替换、回写重试耗尽，任何一处都能让副本停在旧值——之后
 * 每次重启都 `--resume` 到同一个历史点，且无任何报错。
 *
 * 本 store 把「PTY 会话 ↔ resume id」的绑定单独存一份，key = ptySessionId：
 * - **写入方**：history-updated 事件桥（useTerminalResumeIdBridge）。事件带
 *   ptySessionId，不需要 tab/leaf 已就位——这消灭了「事件到达时 leaf.sessionId
 *   尚未写入 → 重试赌时序」的整类问题。
 * - **读取方**：pickCreateSessionResumeId。恢复启动时按 savedSessionId 查本
 *   store，命中即最新权威值；未命中回退 props.resumeId（快照副本）。
 * - **布局快照不参与仲裁**：leaf.resumeId 降级为兼容性副本（旧版本互通），
 *   applyLayoutSnapshotPayload 不 merge、不回填。
 *
 * # 来源仲裁
 *
 * 与后端 `resume_identity.rs` 同口径：manual(40) > issued|osc-title(30) >
 * rollout-scan|backfill(10) > rescue(5)。同级或更高才覆盖（`>=`，与
 * `should_replace_source` 一致）；低优先级来源不得降级已有绑定。
 */

export interface ResumeBinding {
  resumeId: string;
  source?: string;
  /** 本机单调版本：每次接受写入 +1。跨端仲裁的预留字段。 */
  version: number;
  updatedAt: number;
}

/** 与 cc-panes-core/src/services/resume_identity.rs 的优先级表保持镜像。 */
export function resumeSourcePriority(source?: string): number {
  switch (source) {
    case "manual":
      return 40;
    case "issued":
    case "osc-title":
      return 30;
    case "rollout-scan":
    case "backfill":
      return 10;
    case "rescue":
      return 5;
    default:
      // 未知/缺失来源按 issued 档处理：绑定事件的主通道就是 issued/osc-title，
      // 老版本事件可能不带 source，按低档会让主通道打不过陈旧的 manual 残留。
      return 30;
  }
}

/** 绑定超过该时长未更新即视为陈旧，rehydrate 时清除（PTY 会话不会活这么久）。 */
export const RESUME_BINDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface ResumeBindingState {
  bindings: Record<string, ResumeBinding>;
  /** 记录绑定；按来源优先级仲裁，接受返回 true。 */
  recordBinding: (ptySessionId: string, resumeId: string, source?: string) => boolean;
  getBinding: (ptySessionId: string) => ResumeBinding | undefined;
  clearBinding: (ptySessionId: string) => void;
}

export const RESUME_BINDING_STORAGE_KEY = "cc-panes-resume-bindings";
export const RESUME_BINDING_VERSION = 1;

function pruneStale(
  bindings: Record<string, ResumeBinding>,
  now: number,
): Record<string, ResumeBinding> {
  const kept: Record<string, ResumeBinding> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (
      binding
      && typeof binding.resumeId === "string"
      && typeof binding.updatedAt === "number"
      && now - binding.updatedAt < RESUME_BINDING_TTL_MS
    ) {
      kept[key] = binding;
    }
  }
  return kept;
}

export const useResumeBindingStore = create<ResumeBindingState>()(
  persist(
    (set, get) => ({
      bindings: {},

      recordBinding: (ptySessionId, resumeId, source) => {
        const existing = get().bindings[ptySessionId];
        if (existing) {
          if (existing.resumeId === resumeId && existing.source === source) return true;
          // 低优先级来源不得降级已有绑定（与后端 should_replace_source 同口径）。
          if (resumeSourcePriority(source) < resumeSourcePriority(existing.source)) {
            return false;
          }
        }
        set((state) => ({
          bindings: {
            ...state.bindings,
            [ptySessionId]: {
              resumeId,
              source,
              version: (existing?.version ?? 0) + 1,
              updatedAt: Date.now(),
            },
          },
        }));
        return true;
      },

      getBinding: (ptySessionId) => get().bindings[ptySessionId],

      clearBinding: (ptySessionId) => {
        set((state) => {
          if (!state.bindings[ptySessionId]) return state;
          const next = { ...state.bindings };
          delete next[ptySessionId];
          return { bindings: next };
        });
      },
    }),
    {
      name: RESUME_BINDING_STORAGE_KEY,
      version: RESUME_BINDING_VERSION,
      partialize: (state) => ({ bindings: state.bindings }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<Pick<ResumeBindingState, "bindings">>;
        const bindings = persisted?.bindings && typeof persisted.bindings === "object"
          ? pruneStale(persisted.bindings, Date.now())
          : {};
        return { ...currentState, bindings };
      },
    },
  ),
);
