/**
 * CLI 工具服务 — 封装 Tauri IPC 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type { CliToolInfo } from "@/types";

/** 列出所有已注册的 CLI 工具（含实时检测状态） */
export async function listCliTools(): Promise<CliToolInfo[]> {
  return invoke<CliToolInfo[]>("list_cli_tools");
}
