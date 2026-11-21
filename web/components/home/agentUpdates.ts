// 「哪个 Agent 有新版本」的判定：当前版本取 CLI 检测结果（装完回到窗口会重测），
// 最新版本与升级命令来自后端 check_cli_updates。两边任何一个缺都不算有更新。
import type { CliToolInfo } from "@/types";
import type { CliUpdateInfo } from "@/services/cliUpdateService";

export interface AgentUpdate {
  id: string;
  name: string;
  current: string;
  latest: string;
  command: string;
}

/** 从 `2.1.330 (Claude Code)` / `codex-cli 0.169.0` 这类输出里取版本号。 */
export function extractVersion(raw: string | null | undefined): string | null {
  return raw?.match(/\d+(?:\.\d+)+/)?.[0] ?? null;
}

/** 按数字段比较；返回正数表示 a 更新。 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pendingUpdates(
  tools: readonly CliToolInfo[],
  infos: readonly CliUpdateInfo[],
): AgentUpdate[] {
  const byId = new Map(infos.map((info) => [info.id, info]));
  const updates: AgentUpdate[] = [];
  for (const tool of tools) {
    if (!tool.installed) continue;
    const info = byId.get(tool.id);
    const current = extractVersion(tool.version);
    const latest = extractVersion(info?.latestVersion);
    if (!info?.updateCommand || !current || !latest) continue;
    if (compareVersions(latest, current) > 0) {
      updates.push({ id: tool.id, name: tool.displayName, current, latest, command: info.updateCommand });
    }
  }
  return updates;
}

/**
 * 「全部更新」：Unix 上串成一条在同一个终端里跑（用 `;`，一个失败不拦后面的）；
 * Windows 内置终端可能是 cmd 也可能是 PowerShell，分隔符不通用，所以每条各开一个终端。
 */
export function batchUpdateCommands(updates: readonly AgentUpdate[], platform: "mac" | "linux" | "windows"): string[] {
  const commands = updates.map((update) => update.command);
  if (platform === "windows" || commands.length <= 1) return commands;
  return [commands.join("; ")];
}
