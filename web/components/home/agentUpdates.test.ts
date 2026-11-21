import { describe, expect, it } from "vitest";
import type { CliToolInfo } from "@/types";
import type { CliUpdateInfo } from "@/services/cliUpdateService";
import { batchUpdateCommands, compareVersions, extractVersion, pendingUpdates } from "./agentUpdates";

function tool(id: string, version: string | null): CliToolInfo {
  return { id, displayName: id, executable: id, versionArgs: [], installed: true, version, path: `/bin/${id}` };
}

function info(id: string, latestVersion: string | null, updateCommand: string | null = `upgrade ${id}`): CliUpdateInfo {
  return { id, currentVersion: null, latestVersion, source: "npm", package: id, updateCommand };
}

describe("agentUpdates", () => {
  it("extracts the version number from CLI --version output", () => {
    expect(extractVersion("2.1.330 (Claude Code)")).toBe("2.1.330");
    expect(extractVersion("codex-cli 0.169.0")).toBe("0.169.0");
    expect(extractVersion("unknown")).toBeNull();
  });

  it("compares versions numerically, not as strings", () => {
    expect(compareVersions("0.171.0", "0.169.0")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.17.11", "1.19.6")).toBeLessThan(0);
  });

  it("only reports tools whose latest version is newer and that know how to upgrade", () => {
    const tools = [tool("claude", "2.1.330 (Claude Code)"), tool("codex", "codex-cli 0.169.0"), tool("cursor", "1.0.0"), tool("gemini", null)];
    const updates = pendingUpdates(tools, [
      info("claude", "2.1.330"),
      info("codex", "0.171.0"),
      info("cursor", "2.0.0", null),
      info("gemini", "0.2.0"),
    ]);
    expect(updates).toEqual([
      { id: "codex", name: "codex", current: "0.169.0", latest: "0.171.0", command: "upgrade codex" },
    ]);
  });

  it("chains updates into one terminal on unix but keeps one per terminal on windows", () => {
    const updates = [
      { id: "a", name: "a", current: "1", latest: "2", command: "npm i -g a@latest" },
      { id: "b", name: "b", current: "1", latest: "2", command: "brew upgrade b" },
    ];
    expect(batchUpdateCommands(updates, "mac")).toEqual(["npm i -g a@latest; brew upgrade b"]);
    expect(batchUpdateCommands(updates, "windows")).toEqual(["npm i -g a@latest", "brew upgrade b"]);
  });
});
