// 壁纸服务：封装 wallpaper_commands 的 invoke 调用。仅 Tauri 桌面端可用，
// Web 端不消费壁纸（调用方需先用 isTauriRuntime() 门控）。
import { invoke } from "@tauri-apps/api/core";
import type { WallpaperFileInfo } from "@/types";

export async function importWallpaper(
  sourcePath: string,
  kind: "image" | "video" | "audio",
): Promise<WallpaperFileInfo> {
  return invoke<WallpaperFileInfo>("import_wallpaper", { sourcePath, kind });
}

export async function listWallpapers(): Promise<WallpaperFileInfo[]> {
  return invoke<WallpaperFileInfo[]>("list_wallpapers");
}

export async function removeWallpaper(file: string): Promise<void> {
  await invoke("remove_wallpaper", { file });
}

/** 解析壁纸相对文件名为 asset URL（后端做全部安全校验） */
export async function resolveWallpaperAsset(
  file: string,
  kind: "image" | "video" | "audio",
): Promise<string> {
  return invoke<string>("resolve_wallpaper_asset", { file, kind });
}
