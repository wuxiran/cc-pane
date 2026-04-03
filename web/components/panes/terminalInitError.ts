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
    case "WSL_CODEX_NOT_FOUND":
      return [
        red("Codex CLI is not installed inside the target WSL distro."),
        yellow("Open Ubuntu, install Codex CLI there, and confirm `command -v codex` works."),
        ...(detail ? [gray(detail)] : []),
      ];
    case "WSL_CODEX_WINDOWS_SHIM":
      return [
        red("Codex (WSL) resolved to a Windows shim, which is not supported."),
        yellow("Install Codex CLI inside WSL instead of using `/mnt/...`, `.cmd`, `.ps1`, or `.exe` wrappers."),
        ...(detail ? [gray(detail)] : []),
      ];
    case "WSL_NODE_NOT_FOUND":
      return [
        red("Node.js is not installed inside the target WSL distro."),
        yellow("Install Node.js inside WSL and confirm `command -v node` works before starting Codex (WSL)."),
        ...(detail ? [gray(detail)] : []),
      ];
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
