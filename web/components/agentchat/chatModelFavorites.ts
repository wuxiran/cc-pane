// 模型收藏（每用户、跨引擎）。设置 store 落在 Rust 侧模型里，加字段要动后端；
// 这是纯本地 UI 偏好，与 enginePrefs 一样落 localStorage，存储不可用时静默降级。
import type { FavoriteModel } from "./chatModelPickerModel";

const STORAGE_KEY = "ccpanes.acpModelFavorites";

export function loadModelFavorites(): FavoriteModel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is FavoriteModel =>
      Boolean(entry) && typeof entry === "object"
      && typeof (entry as FavoriteModel).engineId === "string"
      && typeof (entry as FavoriteModel).modelId === "string");
  } catch {
    return [];
  }
}

export function saveModelFavorites(favorites: readonly FavoriteModel[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // 隐私模式等存储不可用：本次会话内仍生效，只是不持久。
  }
}
