import { invoke } from "@tauri-apps/api/core";

export type DisplayServer = "wayland" | "x11";

export async function getDisplayServer(): Promise<DisplayServer | null> {
  const value = await invoke<string | null>("get_display_server");
  return value === "wayland" || value === "x11" ? value : null;
}
