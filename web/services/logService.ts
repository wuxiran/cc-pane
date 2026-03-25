import { invoke } from "@tauri-apps/api/core";

/** 日志服务 */
export const logService = {
  /** 获取应用日志目录路径 */
  getLogDir(): Promise<string> {
    return invoke<string>("get_log_dir");
  },
};
