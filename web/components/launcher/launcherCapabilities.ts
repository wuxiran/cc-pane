// 启动器 per-launch 参数的可用性判定。
//
// 背景：chips 是通用 UI，对所有 CLI 一律可点；但 adapter 的 build_command 只消费自己
// 支持的键，不支持的被**静默丢弃**——用户选了 effort=high 却毫无效果且无任何提示。
// 实测 cursor/gemini/kimi/opencode 三个键一个都不消费。
//
// 判定口径见 `resolveLaunchOptionSupport`：**字段缺失 = 支持**，这与直觉相反但必须如此。
import type { CliTool, CliToolCapabilities, CliToolInfo } from "@/types";

/** 受 capability 门控的 per-launch 参数。 */
export type LaunchOptionKey = "effort" | "verbose" | "maxTurns";

const CAPABILITY_FIELD: Record<LaunchOptionKey, keyof CliToolCapabilities> = {
  effort: "supportsEffortOption",
  verbose: "supportsVerboseOption",
  maxTurns: "supportsMaxTurnsOption",
};

export type LaunchOptionSupport = Record<LaunchOptionKey, boolean>;

const ALL_SUPPORTED: LaunchOptionSupport = { effort: true, verbose: true, maxTurns: true };

/**
 * 判定某个 CLI 支持哪些 per-launch 参数。
 *
 * **字段缺失一律按「支持」处理**：这三个位是后加的，运行中的旧 daemon 与安装版都还是
 * 旧二进制、不会发这些字段。若把缺失当「不支持」，版本错配时会把 claude 的 effort 也
 * 置灰——**用能力声明去禁用一个实际可用的功能，比不置灰更糟**。同 CLAUDE.md 的
 * 「服务端新增身份/协议字段必须可缺失」：缺失降级可用，存在且为 false 才是真信号。
 *
 * 拿不到 CliToolInfo（尚未加载完 / 未知 CLI）时同理全开。
 */
export function resolveLaunchOptionSupport(
  cliTool: CliTool,
  tools: CliToolInfo[],
): LaunchOptionSupport {
  if (cliTool === "none") return ALL_SUPPORTED;
  const capabilities = tools.find((tool) => tool.id === cliTool)?.capabilities;
  if (!capabilities) return ALL_SUPPORTED;

  const resolve = (key: LaunchOptionKey): boolean => {
    const declared = capabilities[CAPABILITY_FIELD[key]];
    return typeof declared === "boolean" ? declared : true;
  };

  return { effort: resolve("effort"), verbose: resolve("verbose"), maxTurns: resolve("maxTurns") };
}
