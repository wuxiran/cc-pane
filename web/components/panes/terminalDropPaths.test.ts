import { describe, expect, it } from "vitest";

import {
  formatTerminalPathsForShell,
  quoteShellPath,
  windowsPathToWsl,
  type TerminalRuntimeKind,
} from "./terminalDropPaths";

describe("quoteShellPath", () => {
  it.each([
    ["a plain path", "/tmp/a.txt", "'/tmp/a.txt'"],
    ["a path with spaces (kept as one argument)", "C:\\my dir\\a b.txt", "'C:\\my dir\\a b.txt'"],
    ["non-ASCII characters", "/Users/me/企业基本信息.sql", "'/Users/me/企业基本信息.sql'"],
    // /tmp/o'brien -> '/tmp/o'\''brien'
    ["embedded single quotes via the '\\'' idiom", "/tmp/o'brien", "'/tmp/o'\\''brien'"],
  ])("quotes %s", (_label, input, expected) => {
    expect(quoteShellPath(input)).toBe(expected);
  });
});

describe("windowsPathToWsl", () => {
  it.each<[string, string, string | null]>([
    ["drive-letter path with backslashes", "D:\\repos\\app", "/mnt/d/repos/app"],
    ["drive-letter path with forward slashes", "C:/Users/me", "/mnt/c/Users/me"],
    ["uppercase drive letter is lowercased", "E:\\Data", "/mnt/e/Data"],
    // `C:relative` has no separator after the colon; not a real absolute path.
    ["drive-relative path is not absolute", "C:relative", null],
    ["\\\\wsl.localhost UNC path", "\\\\wsl.localhost\\Ubuntu\\home\\me", "/home/me"],
    ["\\\\wsl$ UNC path", "\\\\wsl$\\Debian\\etc\\hosts", "/etc/hosts"],
    ["non-WSL UNC path", "\\\\server\\share\\file.txt", null],
    ["already-POSIX path", "/home/me/file.txt", null],
    ["relative path", "relative/path.txt", null],
  ])("%s", (_label, input, expected) => {
    expect(windowsPathToWsl(input)).toBe(expected);
  });
});

describe("formatTerminalPathsForShell", () => {
  it.each<[string, string[], TerminalRuntimeKind | undefined, string]>([
    ["quotes and space-joins local paths",
      ["/Users/me/Desktop/企业基本信息.sql", "/tmp/second.sql"], "local",
      "'/Users/me/Desktop/企业基本信息.sql' '/tmp/second.sql'"],
    ["filters out empty paths", ["", "/tmp/a.txt", ""], "local", "'/tmp/a.txt'"],
    ["returns an empty string when all paths are empty", ["", ""], "local", ""],
    ["defaults to local (no WSL conversion) when runtimeKind is omitted", ["D:\\repos\\app"], undefined, "'D:\\repos\\app'"],
    ["converts each wsl path and keeps already-POSIX ones unchanged",
      ["D:\\repos\\app", "/home/me/x.txt"], "wsl", "'/mnt/d/repos/app' '/home/me/x.txt'"],
    ["quotes spaces after wsl conversion", ["D:\\my dir\\a b.txt"], "wsl", "'/mnt/d/my dir/a b.txt'"],
    ["returns an empty string for ssh sessions (honest no-op)", ["D:\\repos\\app"], "ssh", ""],
  ])("%s", (_label, paths, runtimeKind, expected) => {
    const options = runtimeKind ? { runtimeKind } : undefined;
    expect(formatTerminalPathsForShell(paths, options)).toBe(expected);
  });
});
