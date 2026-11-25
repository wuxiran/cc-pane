// CLI 工具白名单校验的单一实现。
// 之前 ProvidersPanel（coerceLaunchTool）与 launcherModel（coerceDefaultCliTool）
// 各有一份同语义副本（并发编排的跨目录改动禁令所致），此处收口。
import type { KnownCliTool } from "@/types";
import { CLI_TOOL_TABS } from "@/types/provider";

const CLI_TOOL_TAB_IDS = new Set<string>(CLI_TOOL_TABS.map((tab) => tab.id));

/**
 * 校验任意字符串是否为合法 CLI 工具：命中 CLI_TOOL_TABS 才采用。
 * 空值 / `"none"`（显式「不启动 CLI」）/ 脏配置一律回落 null，由调用点决定兜底值。
 */
export function coerceCliTool(tool?: string | null): KnownCliTool | null {
  if (!tool || tool === "none") return null;
  return CLI_TOOL_TAB_IDS.has(tool) ? (tool as KnownCliTool) : null;
}

/**
 * 无 YOLO 语义、SSH 启动面未放开的 CLI 及其 SSH 拒绝文案键（providers 命名空间）。
 * Pi 家族 + jcode 见 docs/102；Kiro / fx / Muse 未实机验证，
 * 适配器 supports_yolo=false，SSH 同样不放开（Antigravity 支持 SSH 与 YOLO，不在此列）。
 */
const LOCAL_WSL_ONLY_SSH_UNSUPPORTED_KEYS = {
  pi: "piSshRuntimeUnsupported",
  omp: "ompSshRuntimeUnsupported",
  jcode: "jcodeSshRuntimeUnsupported",
  kiro: "kiroSshRuntimeUnsupported",
  fx: "fxSshRuntimeUnsupported",
  muse: "museSshRuntimeUnsupported",
} as const;

export type LocalWslOnlyCliTool = keyof typeof LOCAL_WSL_ONLY_SSH_UNSUPPORTED_KEYS;

export function isLocalWslOnlyCliTool(tool?: string | null): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_WSL_ONLY_SSH_UNSUPPORTED_KEYS, tool ?? "");
}

/** local/WSL-only CLI 选中 SSH 运行环境时的拒绝文案键（providers 命名空间）。 */
export function localWslOnlySshUnsupportedKey(
  tool?: string | null,
): (typeof LOCAL_WSL_ONLY_SSH_UNSUPPORTED_KEYS)[LocalWslOnlyCliTool] | null {
  return isLocalWslOnlyCliTool(tool)
    ? LOCAL_WSL_ONLY_SSH_UNSUPPORTED_KEYS[tool as LocalWslOnlyCliTool]
    : null;
}
