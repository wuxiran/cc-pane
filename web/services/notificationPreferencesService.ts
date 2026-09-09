import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { invokeOrApi } from "./apiClient";
import { isTauriRuntime } from "./runtime";
import { playNotificationSound } from "@/utils/notificationSound";

export type LayoutSound = { mode: "default" } | { mode: "silent" } | { mode: "custom"; asset: string; name: string };
export interface NotificationPreferences {
  layoutSounds: Record<string, LayoutSound>;
  sessionSnoozes: Record<string, number>;
}
export const emptyNotificationPreferences = (): NotificationPreferences => ({ layoutSounds: {}, sessionSnoozes: {} });
const desktopOnly = async (): Promise<never> => { throw new Error("Notification preferences require the desktop app"); };
let audio: HTMLAudioElement | null = null;
let lastPlayedAt = 0;
export const notificationPreferencesService = {
  get: () => invokeOrApi<NotificationPreferences>("get_notification_preferences", undefined, async () => emptyNotificationPreferences()),
  setSound: (layoutId: string, sound: LayoutSound) => invokeOrApi<NotificationPreferences>("set_layout_notification_sound", { layoutId, sound }, desktopOnly),
  snooze: (sessionId: string, until: number | null) => invokeOrApi<NotificationPreferences>("set_notification_snooze", { sessionId, until }, desktopOnly),
  async importSound(): Promise<LayoutSound | null> {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Sound", extensions: ["mp3", "wav", "ogg"] }] });
    if (!path || Array.isArray(path)) return null;
    return invokeOrApi<LayoutSound>("import_notification_sound", { path }, desktopOnly);
  },
  async play(sound: LayoutSound = { mode: "default" }, preview = false): Promise<void> {
    if (sound.mode === "silent" || (!preview && isTauriRuntime() && getCurrentWebviewWindow().label !== "main")) return;
    const now = Date.now();
    if (!preview && now - lastPlayedAt < 250) return;
    lastPlayedAt = now;
    audio?.pause(); audio = null;
    if (sound.mode === "default") { await playNotificationSound(); return; }
    const path = await invokeOrApi<string>("get_notification_sound_path", { asset: sound.asset }, desktopOnly);
    const clip = new Audio(convertFileSrc(path)); audio = clip;
    const timer = setTimeout(() => { clip.pause(); if (audio === clip) audio = null; }, 5_000);
    clip.onended = () => { clearTimeout(timer); if (audio === clip) audio = null; };
    try { await clip.play(); } catch (error) { clearTimeout(timer); if (audio === clip) audio = null; throw error; }
  },
};
