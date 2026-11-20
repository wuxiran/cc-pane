import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";

export type RuntimeEvent<T> = Event<T>;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export function isWebRuntime(): boolean {
  return !isTauriRuntime();
}

export async function invokeIfTauri<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | undefined> {
  if (!isTauriRuntime()) return undefined;
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

export async function listenIfTauri<T>(
  eventName: string,
  handler: (event: RuntimeEvent<T>) => void | Promise<void>,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<T>(eventName, handler);
}

export async function listenWebviewIfTauri<T>(
  eventName: string,
  handler: (event: RuntimeEvent<T>) => void | Promise<void>,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return getCurrentWebview().listen<T>(eventName, handler);
}

export function getCurrentWindowIfTauri() {
  return isTauriRuntime() ? getCurrentWindow() : null;
}

/** 窗口 + 它的 WebView 一起操作的句柄（底色这类要两层同步的设置用）。 */
export function getCurrentWebviewWindowIfTauri() {
  return isTauriRuntime() ? getCurrentWebviewWindow() : null;
}

export async function logInfoSafe(message: string): Promise<void> {
  if (!isTauriRuntime()) {
    console.info(message);
    return;
  }
  await logInfo(message).catch(() => {});
}

export async function logErrorSafe(message: string): Promise<void> {
  if (!isTauriRuntime()) {
    console.error(message);
    return;
  }
  await logError(message).catch(() => {});
}
