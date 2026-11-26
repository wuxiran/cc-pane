import { describe, expect, it } from "vitest";
import type { TaskBinding, TaskBindingNode, Workspace, WorkspaceProject } from "@/types";
import {
  findWorkspaceProject,
  flattenTaskTree,
  getMetadataUi,
  getProjectLabel,
  getProjectName,
} from "./OrchestratorTaskUtils";

function makeBinding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  return {
    id: "b1",
    title: "task",
    role: "task",
    projectPath: "/tmp/proj",
    cliTool: "claude",
    status: "running",
    progress: 0,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeNode(id: string, children: TaskBindingNode[] = []): TaskBindingNode {
  return { ...makeBinding({ id }), children, depth: 0 };
}

function makeWorkspaceProject(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return { id: `p-${overrides.path ?? "x"}`, path: "/tmp/a", ...overrides };
}

function makeWorkspace(name: string, projects: WorkspaceProject[]): Workspace {
  return {
    id: name,
    name,
    createdAt: "2026-01-01T00:00:00Z",
    projects,
    defaultEnvironment: "local",
  };
}

describe("getMetadataUi", () => {
  it.each<[string, unknown]>([
    ["missing", undefined],
    ["a string", "string"],
    ["a number", 42],
    ["null", null],
    ["an object without ui", {}],
    ["an object with non-object ui", { ui: "nope" }],
    ["an object with null ui", { ui: null }],
  ])("returns empty object when metadata is %s", (_name, metadata) => {
    expect(getMetadataUi(makeBinding({ metadata }))).toEqual({});
  });

  it("returns the ui payload when present", () => {
    const ui = { gitBranch: "main", muted: true, startedAt: 123 };
    expect(getMetadataUi(makeBinding({ metadata: { ui } }))).toEqual(ui);
  });
});

describe("getProjectName", () => {
  it.each([
    ["/home/dev/repo", "repo"],
    ["D:\\workspace\\my-app", "my-app"],
    // trailing separators are ignored
    ["/home/dev/repo/", "repo"],
    ["D:\\workspace\\app\\\\", "app"],
    // falls back to the original path when there are no segments
    ["", ""],
    ["/", "/"],
  ])("getProjectName(%j) -> %j", (path, expected) => {
    expect(getProjectName(path)).toBe(expected);
  });
});

describe("getProjectLabel", () => {
  it("prefers the alias when present", () => {
    expect(getProjectLabel(makeWorkspaceProject({ alias: "Nice Name", path: "/tmp/x" }))).toBe("Nice Name");
  });

  it("falls back to the project name derived from the path", () => {
    expect(getProjectLabel(makeWorkspaceProject({ path: "/tmp/some/repo" }))).toBe("repo");
  });

  it("ignores empty alias", () => {
    expect(getProjectLabel(makeWorkspaceProject({ alias: "", path: "/tmp/some/repo" }))).toBe("repo");
  });
});

describe("findWorkspaceProject", () => {
  const wsA = makeWorkspace("A", [makeWorkspaceProject({ path: "/tmp/a1" }), makeWorkspaceProject({ path: "/tmp/a2" })]);
  const wsB = makeWorkspace("B", [makeWorkspaceProject({ path: "/tmp/b1" })]);

  it("returns null for null path", () => {
    expect(findWorkspaceProject([wsA, wsB], null)).toBeNull();
  });

  it("returns null when no workspace contains the path", () => {
    expect(findWorkspaceProject([wsA, wsB], "/tmp/nope")).toBeNull();
  });

  it("finds the matching workspace/project pair", () => {
    const found = findWorkspaceProject([wsA, wsB], "/tmp/b1");
    expect(found?.workspace.name).toBe("B");
    expect(found?.project.path).toBe("/tmp/b1");
  });

  it("returns the first workspace match in iteration order", () => {
    const wsC = makeWorkspace("C", [makeWorkspaceProject({ path: "/tmp/b1" })]);
    expect(findWorkspaceProject([wsA, wsB, wsC], "/tmp/b1")?.workspace.name).toBe("B");
    expect(findWorkspaceProject([wsC, wsB], "/tmp/b1")?.workspace.name).toBe("C");
  });
});

describe("flattenTaskTree", () => {
  it("returns empty array for empty input", () => {
    expect(flattenTaskTree([])).toEqual([]);
  });

  it("flattens a nested tree in depth-first pre-order", () => {
    const tree: TaskBindingNode[] = [
      makeNode("root1", [makeNode("child1a", [makeNode("grandchild")]), makeNode("child1b")]),
      makeNode("root2"),
    ];
    expect(flattenTaskTree(tree).map((n) => n.id)).toEqual([
      "root1",
      "child1a",
      "grandchild",
      "child1b",
      "root2",
    ]);
  });
});
