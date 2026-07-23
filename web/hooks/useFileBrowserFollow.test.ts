import { describe, expect, it } from "vitest";
import type { Workspace } from "@/types";
import { computeFollowTarget } from "./useFileBrowserFollow";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-a",
    name: "ws-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    path: "D:/workspace-a",
    projects: [{ id: "project-a", path: "D:/workspace-a/project-a" }],
    ...overrides,
  };
}

describe("computeFollowTarget", () => {
  it("workspaceName 命中时跟随工作空间根目录", () => {
    expect(computeFollowTarget({
      followKey: "ws-a|D:/fallback/project",
      workspaces: [makeWorkspace()],
      followed: null,
    })).toBe("D:/workspace-a");
  });

  it("工作空间未命中时回退到 projectPath", () => {
    expect(computeFollowTarget({
      followKey: "missing|D:\\fallback\\project\\",
      workspaces: [makeWorkspace()],
      followed: null,
    })).toBe("D:/fallback/project");
  });

  it("工作空间无可解析根目录时回退到 projectPath", () => {
    expect(computeFollowTarget({
      followKey: "ws-a|D:/fallback/project",
      workspaces: [makeWorkspace({ path: undefined, projects: [] })],
      followed: null,
    })).toBe("D:/fallback/project");
  });

  it("目标与上次跟随相同时不重复导航", () => {
    expect(computeFollowTarget({
      followKey: "ws-a|D:/fallback/project",
      workspaces: [makeWorkspace()],
      followed: "D:/workspace-a",
    })).toBeNull();
  });

  it("终端无工作空间和项目路径时返回 null", () => {
    expect(computeFollowTarget({
      followKey: "|",
      workspaces: [makeWorkspace()],
      followed: null,
    })).toBeNull();
    expect(computeFollowTarget({
      followKey: null,
      workspaces: [makeWorkspace()],
      followed: null,
    })).toBeNull();
  });
});
