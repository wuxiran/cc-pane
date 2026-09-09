import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { usePanesStore } from "@/stores/usePanesStore";
import { useNotificationStore, type NotificationRecord } from "@/stores/useNotificationStore";
import { useNotificationPreferencesStore } from "@/stores/useNotificationPreferencesStore";
import { notificationPreferencesService as service, type LayoutSound } from "@/services/notificationPreferencesService";
import { NotificationSoundControl, NotificationSnoozeControl, SnoozedNotifications } from "./NotificationPreferenceControls";

vi.mock("@/services/notificationPreferencesService", async original => {
  const module = await original<typeof import("@/services/notificationPreferencesService")>();
  return { ...module, notificationPreferencesService: {
    get: vi.fn(async () => module.emptyNotificationPreferences()),
    setSound: vi.fn(async (id: string, sound: LayoutSound) => ({ layoutSounds: { [id]: sound }, sessionSnoozes: {} })),
    snooze: vi.fn(async (id: string, until: number | null) => ({ layoutSounds: {}, sessionSnoozes: until ? { [id]: until } : {} })),
    importSound: vi.fn(async () => ({ mode: "custom", asset: "sound.wav", name: "Alert.wav" })),
    play: vi.fn(async () => {}),
  } };
});

beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("zh-CN");
  const root: PaneNode = { type: "panel", id: "p1", activeTabId: "t1", tabs: [{ id: "t1", title: "Fixture", sessionId: "s1", projectPath: "C:/fixture", contentType: "terminal" } as Tab] };
  usePanesStore.setState({ rootPane: root, currentLayoutId: "layout-a", activePaneId: "p1",
    layouts: [{ id: "layout-a", name: "Alpha", rootPane: root, activePaneId: "p1", kind: "normal" } as LayoutEntry] });
  useNotificationPreferencesStore.setState({ ready: true, preferences: { layoutSounds: {}, sessionSnoozes: {} } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("imports and previews the sound for the owning layout", async () => {
  render(<NotificationSoundControl sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "布局「Alpha」提示音" }));
  fireEvent.click(screen.getByRole("button", { name: "选择声音文件" }));
  await waitFor(() => expect(service.setSound).toHaveBeenCalledWith("layout-a", { mode: "custom", asset: "sound.wav", name: "Alert.wav" }));
  expect(await screen.findByText("Alert.wav")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "试听" }));
  await waitFor(() => expect(service.play).toHaveBeenCalledWith({ mode: "custom", asset: "sound.wav", name: "Alert.wav" }, true));
});

it("mutes only the owning layout and restores its default", async () => {
  render(<NotificationSoundControl sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "布局「Alpha」提示音" }));
  fireEvent.click(screen.getByRole("button", { name: "静音" }));
  await waitFor(() => expect(service.setSound).toHaveBeenCalledWith("layout-a", { mode: "silent" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复默认" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(service.setSound).toHaveBeenLastCalledWith("layout-a", { mode: "default" }));
});

it("shows persistence failures without claiming a sound was saved", async () => {
  vi.mocked(service.setSound).mockRejectedValueOnce(new Error("disk full"));
  render(<NotificationSoundControl sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "布局「Alpha」提示音" }));
  fireEvent.click(screen.getByRole("button", { name: "静音" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  expect(useNotificationPreferencesStore.getState().preferences.layoutSounds).toEqual({});
});

it("snoozes one session, removes only its cards and preserves unread history", async () => {
  useNotificationStore.setState({ activeToastIds: ["a", "b"], notifications: [
    { id: "a", sessionId: "s1", read: false }, { id: "b", sessionId: "s2", read: false },
  ] as NotificationRecord[] });
  render(<NotificationSnoozeControl sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
  fireEvent.change(screen.getByRole("combobox", { name: "暂停时长" }), { target: { value: "custom" } });
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "暂停提醒" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(service.snooze).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "暂停提醒" }));
  await waitFor(() => expect(service.snooze).toHaveBeenCalledWith("s1", expect.any(Number)));
  await waitFor(() => expect(useNotificationStore.getState().activeToastIds).toEqual(["b"]));
  expect(useNotificationStore.getState().notifications[0].read).toBe(false);
});

it("allows early cancellation from notification history", async () => {
  useNotificationPreferencesStore.setState({ preferences: { layoutSounds: {}, sessionSnoozes: { s1: Date.now() + 60_000 } } });
  render(<SnoozedNotifications />);
  expect(screen.getByText(/Fixture/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "提前恢复" }));
  await waitFor(() => expect(service.snooze).toHaveBeenCalledWith("s1", null));
  await waitFor(() => expect(screen.queryByText("已暂停提醒的会话")).not.toBeInTheDocument());
});
