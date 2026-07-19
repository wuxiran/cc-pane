import { describe, expect, it } from "vitest";
import { pickWorkspaceMethods } from "./WorkspaceEmptyActions";
import type { LaunchRecord } from "@/services";

let seq = 0;

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  seq += 1;
  return {
    id: seq,
    projectId: `proj-${seq}`,
    projectName: `proj-${seq}`,
    projectPath: `/tmp/proj-${seq}`,
    launchedAt: new Date(2026, 0, seq).toISOString(),
    ...overrides,
  };
}

describe("pickWorkspaceMethods", () => {
  it("按 workspaceName 过滤并按 CLI×运行环境去重（保留最新一条）", () => {
    const records = [
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "local" }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "local" }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "wsl" }),
      record({ workspaceName: "ws-b", cliTool: "codex", runtimeKind: "local" }),
    ];

    const methods = pickWorkspaceMethods(records, "ws-a");

    expect(methods).toHaveLength(2);
    expect(methods[0]).toBe(records[0]);
    expect(methods.map((m) => `${m.cliTool}|${m.runtimeKind}`)).toEqual([
      "claude|local",
      "claude|wsl",
    ]);
  });

  it("排除纯终端记录并遵守 max 上限", () => {
    const records = [
      record({ workspaceName: "ws-a", cliTool: "none" }),
      record({ workspaceName: "ws-a", cliTool: undefined }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "local" }),
      record({ workspaceName: "ws-a", cliTool: "claude", runtimeKind: "wsl" }),
      record({ workspaceName: "ws-a", cliTool: "codex", runtimeKind: "local" }),
    ];

    expect(pickWorkspaceMethods(records, "ws-a")).toHaveLength(3);
    expect(pickWorkspaceMethods(records, "ws-a", 2)).toHaveLength(2);
    expect(pickWorkspaceMethods(records, "ws-missing")).toHaveLength(0);
  });
});
