import { describe, expect, it } from "vitest";
import { formatTerminalInitError } from "./terminalInitError";

describe("formatTerminalInitError", () => {
  it("formats missing WSL node errors", () => {
    const lines = formatTerminalInitError(
      "WSL_NODE_NOT_FOUND: WSL distro 'Ubuntu' resolves codex to '/mnt/d/.../codex', but node is not available in WSL PATH."
    );

    expect(lines).toEqual([
      "\x1b[31mNode.js is not installed inside the target WSL distro.\x1b[0m",
      "\x1b[33mInstall Node.js inside WSL and confirm `command -v node` works before starting Codex (WSL).\x1b[0m",
      "\x1b[90mWSL distro 'Ubuntu' resolves codex to '/mnt/d/.../codex', but node is not available in WSL PATH.\x1b[0m",
    ]);
  });

  it("formats Windows shim errors", () => {
    const lines = formatTerminalInitError(
      "WSL_CODEX_WINDOWS_SHIM: WSL distro 'Ubuntu' resolves codex to '/mnt/d/.../codex'."
    );

    expect(lines?.[0]).toContain("Windows shim");
    expect(lines?.[1]).toContain("/mnt/...");
  });

  it("formats WSL host resolution errors", () => {
    const lines = formatTerminalInitError(
      "WSL_HOST_UNRESOLVED: could not resolve the Windows host address"
    );

    expect(lines?.[0]).toContain("Failed to resolve the Windows host address");
    expect(lines?.[1]).toContain("ccpanes MCP server");
  });

  it("formats WSL MCP unreachable errors", () => {
    const lines = formatTerminalInitError(
      "WSL_MCP_UNREACHABLE: ccpanes orchestrator at 172.18.64.1:48080 is not reachable from WSL distro 'Ubuntu'."
    );

    expect(lines?.[0]).toContain("not reachable");
    expect(lines?.[1]).toContain("Windows host/port");
  });

  it("formats WSL MCP registration errors", () => {
    const lines = formatTerminalInitError(
      "WSL_MCP_REGISTER_FAILED: failed to register ccpanes MCP for WSL distro 'Ubuntu': exit code 1"
    );

    expect(lines?.[0]).toContain("Failed to register");
    expect(lines?.[1]).toContain("WSL Codex CLI environment");
  });

  it("formats missing WSL Codex config errors", () => {
    const lines = formatTerminalInitError(
      "WSL_CODEX_CONFIG_MISSING: no workspace Provider auth was injected and WSL distro 'Ubuntu' has neither '~/.codex/config.toml' nor '~/.codex/auth.json'. Bind a Provider or configure/sign in to Codex inside WSL first."
    );

    expect(lines?.[0]).toContain("No usable Codex configuration was found");
    expect(lines?.[1]).toContain("~/.codex");
    expect(lines?.[2]).toContain("no workspace Provider auth was injected");
  });

  it("returns null for unknown errors", () => {
    expect(formatTerminalInitError("plain failure")).toBeNull();
  });
});
