import { getCliInstallHint } from "./terminalCliInstallHint";

const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const gray = (text: string) => `\x1b[90m${text}\x1b[0m`;

function splitErrorCode(errorMsg: string): { code: string; detail: string } {
  const separator = errorMsg.indexOf(":");
  if (separator === -1) {
    return { code: errorMsg.trim(), detail: "" };
  }

  return {
    code: errorMsg.slice(0, separator).trim(),
    detail: errorMsg.slice(separator + 1).trim(),
  };
}

export function formatTerminalInitError(errorMsg: string): string[] | null {
  const { code, detail } = splitErrorCode(errorMsg);

  switch (code) {
    case "WSL_CODEX_CONFIG_MISSING":
      return [
        red("No usable Codex configuration was found for the target WSL launch."),
        yellow("Bind a workspace Provider, or configure/sign in to Codex inside WSL so `~/.codex` is usable."),
        ...(detail ? [gray(detail)] : []),
      ];
    case "WSL_HOST_UNRESOLVED":
      return [
        red("Failed to resolve the Windows host address for WSL."),
        yellow("Codex (WSL) cannot attach the ccpanes MCP server until the Windows host address is resolvable."),
        ...(detail ? [gray(detail)] : []),
      ];
    case "WSL_MCP_UNREACHABLE":
      return [
        red("The ccpanes MCP server is not reachable from the target WSL distro."),
        yellow("Ensure CC-Panes is running and the Windows host/port is reachable from WSL before starting Codex (WSL)."),
        ...(detail ? [gray(detail)] : []),
      ];
    case "WSL_MCP_REGISTER_FAILED":
      return [
        red("Failed to register the ccpanes MCP server for Codex (WSL)."),
        yellow("Check the WSL Codex CLI environment, then retry after CC-Panes finishes starting."),
        ...(detail ? [gray(detail)] : []),
      ];
    default:
      return null;
  }
}

/**
 * 启动失败时的取证结果：app 进程侧能不能找到这个 CLI。
 * 由 `probeCliToolDetection` 提供，拿不到（超时/检测失败）时为 null。
 */
export interface CliDetectionProbe {
  installedInApp: boolean;
  resolvedPath?: string | null;
}

// `[\w-]+` 而非 `\w+`：cursor 的可执行名是 `cursor-agent`，`\w+` 只会截到 "agent"，
// 拿去反查检测结果必然落空。
const CLI_NOT_FOUND_RE = /([\w-]+) CLI not found/;

/** 从报错原文里取出「找不到」的那个 CLI 名；不是这类错误时返回 null。 */
export function extractCliNotFoundTool(errorMsg: string): string | null {
  return errorMsg.match(CLI_NOT_FOUND_RE)?.[1] ?? null;
}

/**
 * 初始化失败时写进终端的整段文案（docs/78 批4 从 TerminalView 的 catch 里抽出）。
 *
 * 四级降级：结构化错误码 → 「launcher 环境看不到这个 CLI」（已取证装着）→
 * 「某某 CLI 未安装」附安装指引 → 通用报错。
 * 抽成纯函数是为了让文案可单测——它此前埋在 2000 多行组件的 catch 里，
 * 只能靠手工触发失败才看得到。
 *
 * 第二、三级必须分开：可执行文件是在 cc-panes-daemon 进程里解析的，daemon 的 PATH 是它
 * 被拉起那一刻的快照且跨 app 重启复用，之后新装/挪走的 CLI 它看不见；这种情况喊用户
 * 重装是错的（重装之所以偶尔"有效"，只是因为 shim 恰好落回了 daemon 也认的白名单目录）。
 */
export function describeTerminalInitError(
  errorMsg: string,
  detection?: CliDetectionProbe | null,
): string[] {
  const formatted = formatTerminalInitError(errorMsg);
  if (formatted) return formatted;

  const toolName = extractCliNotFoundTool(errorMsg);
  if (!toolName) {
    return [red(`Failed to initialize terminal session: ${errorMsg}`)];
  }

  if (detection?.installedInApp) {
    const foundAt = detection.resolvedPath ? ` (found at ${detection.resolvedPath})` : "";
    return [
      red(`${toolName} CLI is installed${foundAt}, but the session launcher cannot see it.`),
      yellow("The launcher runs in a background process whose PATH is a snapshot taken when that process started, so CLIs installed or moved afterwards stay invisible to it."),
      yellow(`End the cc-panes-daemon background process (or reboot), then start this session again — reinstalling ${toolName} is not needed.`),
    ];
  }

  const installHint = getCliInstallHint(toolName);
  return [
    red(`${toolName} CLI is not installed or not in PATH.`),
    yellow(`Please install the ${toolName} CLI and make sure it's available in your PATH.`),
    ...(installHint ? [yellow(installHint)] : []),
    // app 进程自身的 PATH 在 Windows 上也是启动时的快照：运行中新装的 CLI 两边都看不见，
    // 只说「去装」会把人引向无谓的重装。
    gray("If you installed it after CC-Panes started, restart CC-Panes (and its cc-panes-daemon background process) so the refreshed PATH is picked up."),
  ];
}
