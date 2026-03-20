import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

type MockInvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown;

/**
 * 配置 Tauri invoke mock，支持按命令名返回不同结果
 *
 * @example
 * ```ts
 * mockTauriInvoke({
 *   list_projects: [{ id: "1", name: "test", path: "/tmp/test", created_at: "2024-01-01" }],
 *   add_project: { id: "2", name: "new", path: "/tmp/new", created_at: "2024-01-02" },
 * });
 * ```
 */
export function mockTauriInvoke(handlers: Record<string, unknown>): void {
  const mockInvoke = invoke as ReturnType<typeof vi.fn>;
  mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (!(cmd in handlers)) {
      return Promise.reject(new Error(`Unhandled invoke command: ${cmd}`));
    }
    const handler = handlers[cmd];
    if (typeof handler === "function") {
      return Promise.resolve((handler as MockInvokeHandler)(cmd, args));
    }
    return Promise.resolve(handler);
  });
}

/**
 * 配置 invoke mock 使某个命令抛出错误
 */
export function mockTauriInvokeError(cmd: string, error: string): void {
  const mockInvoke = invoke as ReturnType<typeof vi.fn>;
  mockInvoke.mockImplementation((invokedCmd: string) => {
    if (invokedCmd === cmd) {
      return Promise.reject(new Error(error));
    }
    return Promise.reject(new Error(`Unhandled invoke command: ${invokedCmd}`));
  });
}

/**
 * 重置 invoke mock
 */
export function resetTauriInvoke(): void {
  const mockInvoke = invoke as ReturnType<typeof vi.fn>;
  mockInvoke.mockReset();
}
