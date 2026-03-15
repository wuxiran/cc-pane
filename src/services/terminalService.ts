/**
 * 终端服务 - 与后端终端会话交互
 *
 * 使用单例监听器模式：全局仅注册一次 terminal-output / terminal-exit 事件监听，
 * 通过 Map<sessionId, callback> 按 sessionId 分发回调。
 * Map.set 的覆盖语义确保同一 sessionId 永远只有一个回调，杜绝输出翻倍。
 */

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { CreateSessionRequest, ResizeRequest, EnvironmentInfo } from "@/types";

// ── 模块级状态：单例监听器 ──────────────────────────────────

const outputCallbacks = new Map<string, (data: string) => void>();
const exitCallbacks = new Map<string, (exitCode: number) => void>();
const pendingBuffers = new Map<string, string[]>();
/** 已 kill 的 session ID 集合，用于事件监听器跳过已死 session */
export const killedSessions = new Set<string>();
const MAX_PENDING_CHUNKS = 1000;
let listenersInitialized = false;
let unlistenOutput: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;

/**
 * 惰性初始化：首次调用时注册两个全局 listener，生命周期与应用一致。
 * 导出供 TerminalView 在 createSession 之前提前调用，缩小事件丢失窗口。
 */
export async function ensureListeners(): Promise<void> {
  if (listenersInitialized) return;
  listenersInitialized = true;

  const webviewWindow = getCurrentWebview();

  unlistenOutput = await webviewWindow.listen<{ sessionId: string; data: string }>(
    "terminal-output",
    (event) => {
      const { sessionId, data } = event.payload;
      if (killedSessions.has(sessionId)) return;
      const cb = outputCallbacks.get(sessionId);
      if (cb) {
        cb(data);
      } else {
        // 回调未注册 — 缓冲等待 flush
        const buf = pendingBuffers.get(sessionId);
        if (buf) {
          if (buf.length >= MAX_PENDING_CHUNKS) {
            buf.splice(0, buf.length - MAX_PENDING_CHUNKS / 2);
          }
          buf.push(data);
        } else {
          pendingBuffers.set(sessionId, [data]);
        }
      }
    }
  );

  unlistenExit = await webviewWindow.listen<{ sessionId: string; exitCode: number }>(
    "terminal-exit",
    (event) => {
      if (killedSessions.has(event.payload.sessionId)) return;
      const cb = exitCallbacks.get(event.payload.sessionId);
      cb?.(event.payload.exitCode);
    }
  );
}

// ── HMR 清理（开发模式） ──────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unlistenOutput?.();
    unlistenExit?.();
    unlistenOutput = null;
    unlistenExit = null;
    listenersInitialized = false;
    outputCallbacks.clear();
    exitCallbacks.clear();
    pendingBuffers.clear();
    killedSessions.clear();
  });
}

// ── 测试辅助 ──────────────────────────────────────────────

/** 仅用于测试：重置单例监听器状态 */
export function _resetListenersForTest(): void {
  outputCallbacks.clear();
  exitCallbacks.clear();
  pendingBuffers.clear();
  killedSessions.clear();
  listenersInitialized = false;
  unlistenOutput = null;
  unlistenExit = null;
}

// ── 服务对象 ──────────────────────────────────────────────

export const terminalService = {
  /** 创建终端会话 */
  async createSession(request: CreateSessionRequest): Promise<string> {
    return invoke<string>("create_terminal_session", { request });
  },

  /** 向终端写入数据 */
  async write(sessionId: string, data: string): Promise<void> {
    return invoke("write_terminal", { sessionId, data });
  },

  /** 调整终端大小 */
  async resize(request: ResizeRequest): Promise<void> {
    return invoke("resize_terminal", { request });
  },

  /** 关闭终端会话 */
  async kill(sessionId: string): Promise<void> {
    return invoke("kill_terminal", { sessionId });
  },

  // ── 断连 API（分屏重连用） ──────────────────────────────

  /** 断连：移除输出回调并清理 pendingBuffers，防止内存泄漏 */
  detachOutput(sessionId: string): void {
    outputCallbacks.delete(sessionId);
    pendingBuffers.delete(sessionId);
  },

  /** 断连：仅移除退出回调 */
  detachExit(sessionId: string): void {
    exitCallbacks.delete(sessionId);
  },

  /** 完整终止 session：清除回调 + 缓冲 + 发送 kill IPC */
  async killSession(sessionId: string): Promise<void> {
    killedSessions.add(sessionId);
    outputCallbacks.delete(sessionId);
    exitCallbacks.delete(sessionId);
    pendingBuffers.delete(sessionId);
    return invoke("kill_terminal", { sessionId });
  },

  // ── 单例监听器 API ─────────────────────────────────────

  /** 注册终端输出回调。Map.set 覆盖语义天然防重复。 */
  async registerOutput(
    sessionId: string,
    callback: (data: string) => void
  ): Promise<void> {
    await ensureListeners();
    outputCallbacks.set(sessionId, callback);
    // Flush 缓冲的早期输出
    const buf = pendingBuffers.get(sessionId);
    if (buf) {
      pendingBuffers.delete(sessionId);
      for (const data of buf) {
        callback(data);
      }
    }
  },

  /** 注销终端输出回调 */
  unregisterOutput(sessionId: string): void {
    outputCallbacks.delete(sessionId);
    pendingBuffers.delete(sessionId);
  },

  /** 注册终端退出回调。Map.set 覆盖语义天然防重复。 */
  async registerExit(
    sessionId: string,
    callback: (exitCode: number) => void
  ): Promise<void> {
    await ensureListeners();
    exitCallbacks.set(sessionId, callback);
  },

  /** 注销终端退出回调 */
  unregisterExit(sessionId: string): void {
    exitCallbacks.delete(sessionId);
  },

  /** 获取 Windows Build Number（用于 xterm.js windowsPty 配置） */
  async getWindowsBuildNumber(): Promise<number> {
    return invoke<number>("get_windows_build_number");
  },

  /** 检测开发环境（Node.js + Claude Code） */
  async checkEnvironment(): Promise<EnvironmentInfo> {
    return invoke<EnvironmentInfo>("check_environment");
  },
};
