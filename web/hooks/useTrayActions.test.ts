// useTrayActions 的监听注册与事件分发测试：tray-action 四个 action 的落点 +
// notification-preferences-changed 的快照/重取两条路径。listenIfTauri 被 mock
// 成同步可用的注册表；非 Tauri 的 no-op 由 runtime 自身保证（runtime.test.ts 覆盖）。
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleTrayAction,
  TRAY_ACTION_EVENT,
  useTrayActions,
} from "./useTrayActions";
import { focusNotificationSession } from "@/components/notifications/notificationActions";
import { takePendingStart } from "@/components/agentchat/pendingStart";
import {
  SETTINGS_NAVIGATE_EVENT,
  type SettingsNavigationTarget,
} from "@/components/settings/settingsNavigation";
import { notificationPreferencesService } from "@/services/notificationPreferencesService";
import { checkForAppUpdates } from "@/services/updaterService";
import { useDialogStore, usePanesStore, useWorkspacesStore } from "@/stores";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useNotificationPreferencesStore } from "@/stores/useNotificationPreferencesStore";
import type { Workspace } from "@/types";

type EventHandler = (event: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, EventHandler>());

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  isWebRuntime: vi.fn(() => false),
  invokeIfTauri: vi.fn(async () => undefined),
  listenIfTauri: vi.fn(async (event: string, handler: EventHandler) => {
    listeners.set(event, handler);
    return () => {
      listeners.delete(event);
    };
  }),
  listenWebviewIfTauri: vi.fn(async () => () => {}),
  getCurrentWindowIfTauri: vi.fn(() => null),
  logErrorSafe: vi.fn(),
  logInfoSafe: vi.fn(),
}));

vi.mock("@/components/notifications/notificationActions", () => ({
  focusNotificationSession: vi.fn(() => true),
}));

vi.mock("@/services/notificationPreferencesService", () => ({
  notificationPreferencesService: {
    get: vi.fn(),
    setSound: vi.fn(),
    snooze: vi.fn(),
    play: vi.fn(),
  },
  emptyNotificationPreferences: () => ({ layoutSounds: {}, sessionSnoozes: {} }),
}));

vi.mock("@/services/updaterService", () => ({
  checkForAppUpdates: vi.fn(async () => undefined),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "demo",
  createdAt: "2026-07-25T00:00:00Z",
  projects: [{ id: "project-1", path: "/workspace/demo" }],
};

describe("handleTrayAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    useWorkspacesStore.setState({
      workspaces: [workspace],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: workspace.projects[0].id,
    });
    usePanesStore.setState({ openAgentChat: vi.fn(() => "tab-tray") });
    useActivityBarStore.setState({ appViewMode: "home" });
    useDialogStore.setState({
      settingsOpen: false,
      trayQuitConfirmOpen: false,
      trayQuitRunningCount: 0,
    });
    useNotificationPreferencesStore.setState({
      preferences: { layoutSounds: {}, sessionSnoozes: {} },
      ready: true,
      error: null,
    });
  });

  it("focus-session 复用通知卡片的会话聚焦路径", () => {
    handleTrayAction({ action: "focus-session", sessionId: "session-1" });

    expect(focusNotificationSession).toHaveBeenCalledWith("session-1");
  });

  it("new-session 复用首页「对 agent 说」链路：默认目录开标签并切工作区，不挂启动意图", () => {
    handleTrayAction({ action: "new-session" });

    expect(usePanesStore.getState().openAgentChat).toHaveBeenCalledWith("/workspace/demo");
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    // 托盘不带 prompt 文本：不挂管家启动意图，引擎选择页接管
    expect(takePendingStart("tab-tray")).toBeNull();
  });

  it("open-settings 打开设置对话框并导航到通用页的托盘子区", () => {
    const seen: SettingsNavigationTarget[] = [];
    const onNavigate = (event: Event) => {
      seen.push((event as CustomEvent<SettingsNavigationTarget>).detail);
    };
    window.addEventListener(SETTINGS_NAVIGATE_EVENT, onNavigate);

    handleTrayAction({ action: "open-settings", section: "tray" });

    window.removeEventListener(SETTINGS_NAVIGATE_EVENT, onNavigate);
    expect(useDialogStore.getState().settingsOpen).toBe(true);
    expect(seen).toEqual([{ paneId: "general", targetSectionId: "general-tray" }]);
  });

  it("confirm-quit 打开退出确认对话框并携带运行会话数", () => {
    handleTrayAction({ action: "confirm-quit", runningCount: 3 });

    expect(useDialogStore.getState().trayQuitConfirmOpen).toBe(true);
    expect(useDialogStore.getState().trayQuitRunningCount).toBe(3);
  });

  it("switch-workspace 与侧栏点击同一动作：展开目标工作区", () => {
    useWorkspacesStore.setState({ expandedWorkspaceId: null });

    handleTrayAction({ action: "switch-workspace", workspaceId: "workspace-1" });

    expect(useWorkspacesStore.getState().expandedWorkspaceId).toBe("workspace-1");
  });

  it("check-updates 走用户主动触发的更新检查链路", () => {
    handleTrayAction({ action: "check-updates" });

    expect(checkForAppUpdates).toHaveBeenCalledWith(true);
  });
});

describe("useTrayActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    useDialogStore.setState({ trayQuitConfirmOpen: false, trayQuitRunningCount: 0 });
    useNotificationPreferencesStore.setState({
      preferences: { layoutSounds: {}, sessionSnoozes: {} },
      ready: true,
      error: null,
    });
  });

  it("注册 tray-action 与 notification-preferences-changed 监听，卸载时反注册", async () => {
    const { unmount } = renderHook(() => useTrayActions());

    await waitFor(() => {
      expect(listeners.has(TRAY_ACTION_EVENT)).toBe(true);
      expect(listeners.has("notification-preferences-changed")).toBe(true);
    });

    listeners.get(TRAY_ACTION_EVENT)?.({ payload: { action: "confirm-quit", runningCount: 2 } });
    expect(useDialogStore.getState().trayQuitRunningCount).toBe(2);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it("notification-preferences-changed 带快照时直接采用，不向后端重取", async () => {
    renderHook(() => useTrayActions());
    await waitFor(() => expect(listeners.has("notification-preferences-changed")).toBe(true));
    const snapshot = { layoutSounds: {}, sessionSnoozes: { "session-1": 123 } };

    listeners.get("notification-preferences-changed")?.({ payload: snapshot });

    expect(useNotificationPreferencesStore.getState().preferences).toEqual(snapshot);
    expect(useNotificationPreferencesStore.getState().ready).toBe(true);
    expect(notificationPreferencesService.get).not.toHaveBeenCalled();
  });

  it("notification-preferences-changed 无 payload 时向后端重取偏好", async () => {
    const reloaded = { layoutSounds: {}, sessionSnoozes: { "session-2": 456 } };
    vi.mocked(notificationPreferencesService.get).mockResolvedValue(reloaded);
    renderHook(() => useTrayActions());
    await waitFor(() => expect(listeners.has("notification-preferences-changed")).toBe(true));

    listeners.get("notification-preferences-changed")?.({ payload: null });

    await waitFor(() =>
      expect(useNotificationPreferencesStore.getState().preferences).toEqual(reloaded),
    );
    expect(notificationPreferencesService.get).toHaveBeenCalled();
  });
});
