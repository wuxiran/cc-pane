import { invoke } from "@tauri-apps/api/core";
import type { ProcessScanResult } from "@/types";

export const processService = {
  /** 扫描系统中所有 Claude 相关进程 */
  async scan(): Promise<ProcessScanResult> {
    return invoke<ProcessScanResult>("scan_claude_processes");
  },

  /** 终止单个进程 */
  async killProcess(pid: number): Promise<boolean> {
    return invoke<boolean>("kill_claude_process", { pid });
  },

  /** 批量终止进程，返回 [pid, success] 数组 */
  async killProcesses(pids: number[]): Promise<[number, boolean][]> {
    return invoke<[number, boolean][]>("kill_claude_processes", { pids });
  },
};
