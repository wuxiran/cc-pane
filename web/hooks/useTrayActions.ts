// 系统托盘事件前端分发：Rust 托盘菜单点击 emit「tray-action」，偏好即改即生效
// 走「notification-preferences-changed」。Web 运行时 listenIfTauri 全部 no-op。
// 事件名与 payload 契约与 src-tauri 托盘实现共同约定，勿擅改。
import { useEffect } from "react";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import {
  launchAgentChatSession,
  resolveDefaultAgentCwd,
} from "@/components/home/agentPromptLaunch";
import { listenIfTauri } from "@/services/runtime";
import type { NotificationPreferences } from "@/services/notificationPreferencesService";
import { checkForAppUpdates } from "@/services/updaterService";
import { useDialogStore, useSettingsStore, useWorkspacesStore } from "@/stores";
import { applyNotificationPreferencesEvent } from "@/stores/useNotificationPreferencesStore";

export const TRAY_ACTION_EVENT = "tray-action";
export const SETTINGS_CHANGED_EVENT = "settings-changed";

export type TrayActionPayload =
  | { action: "focus-session"; sessionId: string }
  | { action: "new-session" }
  | { action: "switch-workspace"; workspaceId: string }
  | { action: "open-settings"; section?: string }
  | { action: "check-updates" }
  | { action: "confirm-quit"; runningCount: number };

export function handleTrayAction(payload: TrayActionPayload): void {
  switch (payload.action) {
    // 与通知卡片「聚焦会话」同一条路径：找到 tab 即聚焦并切回分屏视图；
    // 会话已不在任何布局时 focusNotificationSession 返回 false，自然 no-op。
    case "focus-session":
      focusNotificationSession(payload.sessionId);
      return;
    // 完全复用首页「对 agent 说」链路：同一默认目标解析 + 开 agent-chat 标签 +
    // 切工作区视图。托盘不带 prompt 文本，不挂管家启动意图，引擎选择页接管。
    case "new-session": {
      const { workspaces, expandedWorkspaceId, expandedProjectId } =
        useWorkspacesStore.getState();
      launchAgentChatSession({
        cwd: resolveDefaultAgentCwd(workspaces, expandedWorkspaceId, expandedProjectId),
      });
      return;
    }
    // 契约 section 目前只有 "tray"：落到设置「通用」页的系统托盘子区。
    case "open-settings":
      navigateToSettings({ paneId: "general", targetSectionId: "general-tray" });
      return;
    // 托盘「切换工作区」：与侧栏点击同一动作——展开目标工作区（主窗口 Rust 已唤起）。
    case "switch-workspace":
      useWorkspacesStore.getState().expandWorkspace(payload.workspaceId);
      return;
    // 托盘「检查更新」：用户主动触发（可见反馈），与设置页入口同一链路。
    case "check-updates":
      void checkForAppUpdates(true);
      return;
    case "confirm-quit":
      useDialogStore.getState().openTrayQuitConfirm(payload.runningCount);
      return;
  }
}

export function useTrayActions(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri<TrayActionPayload>(TRAY_ACTION_EVENT, (event) => {
      if (!cancelled && event.payload) handleTrayAction(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri<NotificationPreferences | null>(
      "notification-preferences-changed",
      (event) => {
        if (!cancelled) applyNotificationPreferencesEvent(event.payload);
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 托盘「设置」子菜单勾选通用开关后，Rust 广播 settings-changed：
  // 设置页若开着，重新拉取保持勾选态一致。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listenIfTauri(SETTINGS_CHANGED_EVENT, () => {
      if (!cancelled) void useSettingsStore.getState().loadSettings();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
