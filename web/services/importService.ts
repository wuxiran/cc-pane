/**
 * 一键导入协议前端服务：解析/执行导入命令 + 监听 deep-link 事件。
 * 后端在收到 ccpanes:// 链接后 emit `ccpanes-import`（成功解析）/`ccpanes-import-error`。
 */
import { invoke } from "@tauri-apps/api/core";
import { listenIfTauri } from "@/services/runtime";

export type ImportRequest =
  | { resource: "provider"; name: string; app: string; endpoints: string[]; apiKey?: string | null }
  | { resource: "skill"; id?: string | null; repo?: string | null }
  | { resource: "mcp"; name: string; config: unknown };

export const importService = {
  /** 解析 ccpanes:// 链接（不落盘，供确认弹窗展示） */
  async parseImportUrl(url: string): Promise<ImportRequest> {
    return invoke<ImportRequest>("parse_import_url", { url });
  },

  /** 用户确认后执行导入，返回一句结果说明 */
  async executeImport(request: ImportRequest): Promise<string> {
    return invoke<string>("execute_import", { request });
  },

  /** 领取冷启动时暂存的导入（应用关着时点链接的场景）。非桌面端返回 null。 */
  async takePendingImport(): Promise<ImportRequest | null> {
    try {
      return await invoke<ImportRequest | null>("take_pending_import");
    } catch {
      return null;
    }
  },

  /** 监听 deep-link 解析成功事件 */
  onImport(cb: (req: ImportRequest) => void): Promise<() => void> {
    return listenIfTauri<ImportRequest>("ccpanes-import", (event) => cb(event.payload));
  },

  /** 监听 deep-link 解析失败事件 */
  onImportError(cb: (msg: string) => void): Promise<() => void> {
    return listenIfTauri<string>("ccpanes-import-error", (event) => cb(event.payload));
  },
};
