import { describe, expect, it } from "vitest";
import { describeTerminalInitError, formatTerminalInitError } from "./terminalInitError";

describe("formatTerminalInitError", () => {
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

// 从 TerminalView 的 catch 抽出后才可测（docs/78 批4）。
describe("describeTerminalInitError", () => {
  it("结构化错误码优先", () => {
    const lines = describeTerminalInitError("WSL_HOST_UNRESOLVED: boom");
    expect(lines[0]).toContain("Failed to resolve the Windows host address");
  });

  it("CLI 未安装：报错 + 指引 + 安装命令", () => {
    const lines = describeTerminalInitError("opencode CLI not found in PATH");
    expect(lines[0]).toContain("opencode CLI is not installed");
    expect(lines[1]).toContain("available in your PATH");
    expect(lines[2]).toContain("npm install -g opencode-ai");
  });

  it("无安装指引的 CLI 只给两行", () => {
    expect(describeTerminalInitError("claude CLI not found")).toHaveLength(2);
  });

  it("其余错误走通用文案，且原文照带", () => {
    const lines = describeTerminalInitError("plain failure");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("plain failure");
  });
});
