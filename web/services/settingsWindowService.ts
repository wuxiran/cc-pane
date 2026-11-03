import { emit, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindowIfTauri, invokeIfTauri, isTauriRuntime } from "./runtime";

export const SETTINGS_CHANGED_EVENT = "settings-changed";
export const SETTINGS_WINDOW_NAVIGATE_EVENT = "settings-window-navigate";
export const SETTINGS_WINDOW_ACTION_EVENT = "settings-window-action";

export interface SettingsWindowTarget {
  paneId: string;
  targetSectionId?: string;
}

/** 设置窗口里触发、必须在主窗口执行的操作（两个窗口的 store 互不相通）。 */
export type SettingsWindowAction =
  | { type: "openOnboarding" }
  | { type: "openSkillManager"; args: unknown[] };

export interface SettingsChangedPayload {
  source?: string;
}

export function isSettingsWindow(): boolean {
  return (
    typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("mode") === "settings"
  );
}

/** 桌面用独立窗口，Web 壳没有多窗口，继续用弹窗。 */
export function usesSettingsWindow(): boolean {
  return isTauriRuntime() && !isSettingsWindow();
}

export function openSettingsWindow(target?: SettingsWindowTarget): Promise<void> {
  return invokeIfTauri<void>("open_settings_window", {
    paneId: target?.paneId ?? null,
    sectionId: target?.targetSectionId ?? null,
  });
}

export function currentWindowLabel(): string | undefined {
  try {
    return getCurrentWindowIfTauri()?.label;
  } catch {
    return undefined;
  }
}

/** 广播配置已保存，其他窗口据此重载；带来源 label，发送方自己忽略。 */
export function broadcastSettingsChanged(): void {
  if (!isTauriRuntime()) return;
  try {
    void Promise.resolve(
      emit(SETTINGS_CHANGED_EVENT, { source: currentWindowLabel() } satisfies SettingsChangedPayload),
    ).catch(() => undefined);
  } catch {
    // 广播失败不影响保存本身；其他窗口下次加载时拿到新值。
  }
}

export function sendActionToMainWindow(action: SettingsWindowAction): Promise<void> {
  return emitTo("main", SETTINGS_WINDOW_ACTION_EVENT, action);
}

/** 设置窗口里的 store 没有分屏，Skill 管理标签要在主窗口打开。 */
export function routeSkillManager<F extends (...args: never[]) => unknown>(openSkillManager: F): F {
  if (!isSettingsWindow()) return openSkillManager;
  return ((...args: unknown[]) => {
    void sendActionToMainWindow({ type: "openSkillManager", args });
  }) as unknown as F;
}
