/**
 * Agent CLI 新版本检测 — 后端按安装来源查最新版本并给出升级命令（cli_update_service.rs）。
 * 浏览器 / cc-panes-web 模式没有这个能力，直接返回空列表。
 */
import { invokeOrApi } from "./apiClient";

export type CliInstallSource = "npm" | "bun" | "brew" | "brew-cask" | "native";

export interface CliUpdateInfo {
  id: string;
  currentVersion: string | null;
  latestVersion: string | null;
  source: CliInstallSource;
  package: string | null;
  /** 在终端里执行即可升级；null = 不知道怎么升。 */
  updateCommand: string | null;
}

export async function checkCliUpdates(): Promise<CliUpdateInfo[]> {
  return invokeOrApi<CliUpdateInfo[]>("check_cli_updates", undefined, () => Promise.resolve([]));
}
