import { describe, expect, it } from "vitest";
import {
  describeTerminalInitError,
  extractCliNotFoundTool,
  formatTerminalInitError,
} from "./terminalInitError";

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

  it("CLI 未安装：报错 + 指引 + 安装命令 + 重启提示", () => {
    const lines = describeTerminalInitError("opencode CLI not found in PATH");
    expect(lines[0]).toContain("opencode CLI is not installed");
    expect(lines[1]).toContain("available in your PATH");
    expect(lines[2]).toContain("npm install -g opencode-ai");
    expect(lines[3]).toContain("restart CC-Panes");
  });

  it("无安装指引的 CLI 不给安装命令行", () => {
    const lines = describeTerminalInitError("claude CLI not found");
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("npm install");
  });

  it("其余错误走通用文案，且原文照带", () => {
    const lines = describeTerminalInitError("plain failure");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("plain failure");
  });

  // daemon 的 PATH 是它启动那一刻的快照，与 app 进程不是同一套环境。
  // app 侧能找到时喊用户重装是错的——重装"有效"只是因为 shim 落回了白名单目录。
  it("app 侧检测已安装：判为 launcher 环境陈旧，不喊重装", () => {
    const lines = describeTerminalInitError("claude CLI not found in PATH or common install locations", {
      installedInApp: true,
      resolvedPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
    });

    expect(lines[0]).toContain("is installed");
    expect(lines[0]).toContain("claude.cmd");
    expect(lines[1]).toContain("background process");
    expect(lines[2]).toContain("reinstalling claude is not needed");
    expect(lines.join("\n")).not.toContain("Please install");
  });

  it("app 侧检测已安装但没拿到路径：仍判环境陈旧，只是不附路径", () => {
    const lines = describeTerminalInitError("codex CLI not found", { installedInApp: true });

    expect(lines[0]).toContain("codex CLI is installed");
    expect(lines[0]).not.toContain("found at");
    expect(lines[2]).toContain("cc-panes-daemon");
  });

  it("app 侧也未安装：保持原来的安装指引", () => {
    const lines = describeTerminalInitError("opencode CLI not found in PATH", {
      installedInApp: false,
      resolvedPath: null,
    });

    expect(lines[0]).toContain("opencode CLI is not installed");
    expect(lines[2]).toContain("npm install -g opencode-ai");
  });

  it("取证失败（null）：回退到安装指引，不臆断环境陈旧", () => {
    const lines = describeTerminalInitError("claude CLI not found", null);

    expect(lines[0]).toContain("claude CLI is not installed");
    expect(lines.join("\n")).not.toContain("is installed at");
  });
});

describe("extractCliNotFoundTool", () => {
  it("取出连字符可执行名（cursor-agent 不被截成 agent）", () => {
    expect(
      extractCliNotFoundTool("cursor-agent CLI not found in PATH or common install locations"),
    ).toBe("cursor-agent");
  });

  it("非 CLI 未安装类错误返回 null", () => {
    expect(extractCliNotFoundTool("WSL_HOST_UNRESOLVED: boom")).toBeNull();
    expect(extractCliNotFoundTool("plain failure")).toBeNull();
  });
});
