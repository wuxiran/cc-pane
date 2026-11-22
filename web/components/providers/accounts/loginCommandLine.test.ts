import { describe, expect, it } from "vitest";
import type { LoginCommand } from "@/types/provider";
import {
  encodePowershellCommand,
  loginCommandLine,
  loginTerminalCommand,
  posixLoginCommandLine,
  posixQuote,
  powershellLoginScript,
} from "./loginCommandLine";

function command(overrides: Partial<LoginCommand> = {}): LoginCommand {
  return {
    cliTool: "claude",
    command: "/usr/local/bin/claude",
    args: ["auth", "login"],
    env: { CLAUDE_CONFIG_DIR: "/data/login-accounts/claude-1" },
    envRemove: [],
    interactive: false,
    executableFound: true,
    ...overrides,
  };
}

describe("posix login command line", () => {
  it("quotes the command, args and values with single quotes", () => {
    expect(posixLoginCommandLine(command())).toBe(
      "env CLAUDE_CONFIG_DIR='/data/login-accounts/claude-1' '/usr/local/bin/claude' 'auth' 'login'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`);
    const line = posixLoginCommandLine(command({ env: { CLAUDE_CONFIG_DIR: "/Users/o'neil/dir" } }));
    expect(line).toContain(`CLAUDE_CONFIG_DIR='/Users/o'\\''neil/dir'`);
  });

  it("removes inherited variables with env -u before assignments", () => {
    const line = posixLoginCommandLine(command({
      envRemove: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
      env: { CLAUDE_CONFIG_DIR: "/d", SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" },
    }));
    expect(line).toBe(
      "env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR='/d' SSH_CONNECTION='127.0.0.1 0 127.0.0.1 0' '/usr/local/bin/claude' 'auth' 'login'",
    );
  });

  it("drops variable names that are not shell identifiers", () => {
    const line = posixLoginCommandLine(command({ env: { "BAD;rm": "x", OK: "1" }, envRemove: ["$(x)"] }));
    expect(line).toBe("env OK='1' '/usr/local/bin/claude' 'auth' 'login'");
  });

  it("omits env when there is nothing to set or remove", () => {
    expect(posixLoginCommandLine(command({ env: {}, args: [] }))).toBe("'/usr/local/bin/claude'");
  });
});

describe("windows login command", () => {
  it("builds a PowerShell script with doubled single quotes", () => {
    const script = powershellLoginScript(command({
      command: "C:\\Tools\\claude.exe",
      env: { CLAUDE_CONFIG_DIR: "C:\\Users\\o'neil\\acc" },
      envRemove: ["ANTHROPIC_API_KEY"],
    }));
    expect(script).toBe(
      "Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; "
      + "$env:CLAUDE_CONFIG_DIR='C:\\Users\\o''neil\\acc'; & 'C:\\Tools\\claude.exe' 'auth' 'login'",
    );
    expect(loginCommandLine(command(), "windows")).toBe(powershellLoginScript(command()));
  });

  it("submits an encoded command so the outer shell never expands it", () => {
    const line = loginTerminalCommand(command(), "windows");
    expect(line).toMatch(/^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
    const encoded = line.split(" ").pop() ?? "";
    const bytes = atob(encoded);
    let decoded = "";
    for (let index = 0; index < bytes.length; index += 2) {
      decoded += String.fromCharCode(bytes.charCodeAt(index) | (bytes.charCodeAt(index + 1) << 8));
    }
    expect(decoded).toBe(powershellLoginScript(command()));
    expect(encodePowershellCommand("a")).toBe(btoa("a\u0000"));
  });

  it("posix terminal command equals the readable line", () => {
    expect(loginTerminalCommand(command(), "posix")).toBe(loginCommandLine(command(), "posix"));
  });
});
