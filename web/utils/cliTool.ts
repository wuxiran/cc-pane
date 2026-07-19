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
