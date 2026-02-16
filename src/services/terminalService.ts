/**
 * 终端服务 - 与后端终端会话交互
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CreateSessionRequest, ResizeRequest } from "@/types";

export const terminalService = {
  /**
   * 创建终端会话
   */
  async createSession(request: CreateSessionRequest): Promise<string> {
    return invoke<string>("create_terminal_session", { request });
  },

  /**
   * 向终端写入数据
   */
  async write(sessionId: string, data: string): Promise<void> {
    return invoke("write_terminal", { sessionId, data });
  },

  /**
   * 调整终端大小
   */
  async resize(request: ResizeRequest): Promise<void> {
    return invoke("resize_terminal", { request });
  },

  /**
   * 关闭终端会话
   */
  async kill(sessionId: string): Promise<void> {
    return invoke("kill_terminal", { sessionId });
  },

  /**
   * 监听终端输出
   */
  async onOutput(
    callback: (sessionId: string, data: string) => void
  ): Promise<UnlistenFn> {
    return listen<{ sessionId: string; data: string }>(
      "terminal-output",
      (event) => {
        callback(event.payload.sessionId, event.payload.data);
      }
    );
  },

  /**
   * 监听终端退出
   */
  async onExit(
    callback: (sessionId: string, exitCode: number) => void
  ): Promise<UnlistenFn> {
    return listen<{ sessionId: string; exitCode: number }>(
      "terminal-exit",
      (event) => {
        callback(event.payload.sessionId, event.payload.exitCode);
      }
    );
  },
};
