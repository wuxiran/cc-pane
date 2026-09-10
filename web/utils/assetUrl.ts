// 本地绝对路径 → 前端可加载的 URL。Tauri 走 asset 协议（CSP 已放行
// asset:/http://asset.localhost），web 部署（cc-panes-web）走 fs raw 接口。
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/services/runtime";

export function toAssetUrl(absolutePath: string): string {
  return isTauriRuntime()
    ? convertFileSrc(absolutePath)
    : `/api/fs/raw?path=${encodeURIComponent(absolutePath)}`;
}
