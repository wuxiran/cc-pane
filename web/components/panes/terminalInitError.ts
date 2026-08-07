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
 * 初始化失败时写进终端的整段文案（docs/78 批4 从 TerminalView 的 catch 里抽出）。
 *
 * 三级降级：结构化错误码 → 「某某 CLI 未安装」附安装指引 → 通用报错。
 * 抽成纯函数是为了让文案可单测——它此前埋在 2000 多行组件的 catch 里，
 * 只能靠手工触发失败才看得到。
 */
export function describeTerminalInitError(errorMsg: string): string[] {
  const formatted = formatTerminalInitError(errorMsg);
  if (formatted) return formatted;

  const cliNotFoundMatch = errorMsg.match(/(\w+) CLI not found/);
  if (!cliNotFoundMatch) {
    return [red(`Failed to initialize terminal session: ${errorMsg}`)];
  }
  const toolName = cliNotFoundMatch[1];
  const installHint = getCliInstallHint(toolName);
  return [
    red(`${toolName} CLI is not installed or not in PATH.`),
    yellow(`Please install the ${toolName} CLI and make sure it's available in your PATH.`),
    ...(installHint ? [yellow(installHint)] : []),
  ];
}
