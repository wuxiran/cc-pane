import { describe, expect, it } from "vitest";
import type { LaunchRecord } from "@/services/historyService";
import type { AcpChatHistoryEntry } from "@/types/agentChat";
import type { Workspace } from "@/types";
import {
  defaultContextWorkspace,
  groupByProject,
  groupByWorkspace,
  mergeSessions,
  normalizePath,
  pinnedSessions,
  recentSessions,
  primaryFolder,
  userWorkspaces,
  workspaceCwd,
  workspaceFolders,
} from "./simpleExplorerModel";

function record(partial: Partial<LaunchRecord> & { id: number }): LaunchRecord {
  return {
    projectId: `p${partial.id}`,
    projectName: "demo",
    projectPath: "/repos/demo",
    launchedAt: "2026-11-03T10:00:00Z",
    resumeSessionId: `sess-${partial.id}`,
    ...partial,
  };
}

function chat(partial: Partial<AcpChatHistoryEntry> & { acpSessionId: string }): AcpChatHistoryEntry {
  return { engineId: "claude", cwd: "/repos/demo", title: "", createdAt: 1, updatedAt: 1, ...partial };
}

function workspace(partial: Partial<Workspace> & { name: string }): Workspace {
  return { id: partial.name, createdAt: "", projects: [], ...partial };
}

const ws = [
  workspace({ name: "default", isDefault: true, projects: [{ id: "d", path: "/base/default" }] }),
  workspace({ name: "agent-chat", isAgentChat: true, projects: [] }),
  workspace({ name: "cc-pane", projects: [{ id: "a", path: "/repos/demo" }, { id: "b", path: "/repos/demo/sub" }] }),
  workspace({ name: "beta", projects: [{ id: "c", path: "C:\\work\\Beta\\" }, { id: "x", path: "/gone", archivedAt: "2026-01-01" }] }),
  workspace({ name: "old", archivedAt: "2026-01-01", projects: [{ id: "o", path: "/old" }] }),
];

describe("mergeSessions", () => {
  it("drops records without resume id and chats without session id, newest first", () => {
    const sessions = mergeSessions(
      [record({ id: 1, launchedAt: "2026-11-03T10:00:00Z" }), record({ id: 2, resumeSessionId: undefined })],
      [chat({ acpSessionId: "c1", updatedAt: Date.parse("2026-11-03T11:00:00Z") }), chat({ acpSessionId: "" })],
    );
    expect(sessions.map((s) => s.key)).toEqual(["chat:c1", "launch:1"]);
  });

  it("titles: prompt truncated at 40 chars, else project name; chat falls back to short id", () => {
    const long = "x".repeat(50);
    const [withPrompt, noPrompt] = mergeSessions(
      [record({ id: 1, lastPrompt: long }), record({ id: 2, launchedAt: "2026-11-02T10:00:00Z" })],
      [],
    );
    expect(withPrompt.title).toBe(`${"x".repeat(40)}…`);
    expect(noPrompt.title).toBe("demo");
    const [c] = mergeSessions([], [chat({ acpSessionId: "abcdefgh-rest" })]);
    expect(c.title).toBe("abcdefgh");
  });
});

describe("userWorkspaces", () => {
  it("removes system and archived workspaces, keeps order", () => {
    expect(userWorkspaces(ws).map((w) => w.name)).toEqual(["cc-pane", "beta"]);
  });
});

describe("normalizePath", () => {
  it("unifies separators, strips trailing slash, lowercases only windows paths", () => {
    expect(normalizePath("C:\\work\\Beta\\")).toBe("c:/work/beta");
    expect(normalizePath("/repos/Demo/")).toBe("/repos/Demo");
  });
});

describe("groupByProject", () => {
  it("assigns by longest matching project root and keeps workspace/project order", () => {
    const sessions = mergeSessions(
      [record({ id: 1, projectPath: "/repos/demo/sub/deeper" }), record({ id: 2, projectPath: "/repos/demo/" })],
      [chat({ acpSessionId: "c1", cwd: "c:/work/beta/pkg" }), chat({ acpSessionId: "c2", cwd: "/elsewhere" })],
    );
    const groups = groupByProject(sessions, ws);
    expect(groups.map((g) => g.workspace?.name ?? null)).toEqual(["cc-pane", "beta", null]);
    const [ccPane, beta, other] = groups;
    expect(ccPane.projects.map((p) => [p.project?.id, p.sessions.map((s) => s.key)])).toEqual([
      ["a", ["launch:2"]],
      ["b", ["launch:1"]],
    ]);
    expect(beta.projects.map((p) => p.project?.id)).toEqual(["c"]);
    expect(beta.projects[0].sessions.map((s) => s.key)).toEqual(["chat:c1"]);
    expect(other.projects[0].project).toBeNull();
    expect(other.projects[0].sessions.map((s) => s.key)).toEqual(["chat:c2"]);
  });

  it("sessions under the system default workspace go to other", () => {
    const groups = groupByProject(mergeSessions([record({ id: 1, projectPath: "/base/default" })], []), ws);
    expect(groups[groups.length - 1].workspace).toBeNull();
  });

  it("omits the other group when everything matched", () => {
    const groups = groupByProject(mergeSessions([record({ id: 1 })], []), ws);
    expect(groups.every((g) => g.workspace !== null)).toBe(true);
  });
});

describe("recentSessions / pinnedSessions", () => {
  const sessions = mergeSessions([record({ id: 1 }), record({ id: 2, launchedAt: "2026-11-01T00:00:00Z" })], []);

  it("limits recent", () => {
    expect(recentSessions(sessions, 1).map((s) => s.key)).toEqual(["launch:1"]);
  });

  it("returns pinned in key order and ignores missing keys", () => {
    expect(pinnedSessions(sessions, ["launch:2", "chat:nope", "launch:1"]).map((s) => s.key)).toEqual(["launch:2", "launch:1"]);
  });
});

describe("defaultContextWorkspace", () => {
  it("prefers the named workspace when usable, else the first user workspace", () => {
    expect(defaultContextWorkspace(ws, "beta")?.name).toBe("beta");
    expect(defaultContextWorkspace(ws, "old")?.name).toBe("cc-pane");
    expect(defaultContextWorkspace(ws, "default")?.name).toBe("cc-pane");
    expect(defaultContextWorkspace(ws, null)?.name).toBe("cc-pane");
    expect(defaultContextWorkspace([ws[0], ws[1]], null)).toBeNull();
  });
});

describe("workspace-level grouping", () => {
  const workspace = {
    id: "w", name: "w", createdAt: "", path: "/repos/main",
    projects: [
      { id: "a", path: "/repos/tools" },
      { id: "b", path: "/repos/main" },
      { id: "z", path: "/repos/old", archivedAt: "2026-01-01T00:00:00Z" },
    ],
  } as Workspace;

  it("merges the sessions of every folder in a workspace, newest first", () => {
    const sessions = mergeSessions(
      [record({ id: 1, projectPath: "/repos/tools", launchedAt: "2026-11-03T10:00:00Z" })],
      [
        chat({ acpSessionId: "new", cwd: "/repos/main/pkg", updatedAt: Date.parse("2026-11-03T12:00:00Z") }),
        chat({ acpSessionId: "old", cwd: "/repos/main", updatedAt: Date.parse("2026-11-03T09:00:00Z") }),
        chat({ acpSessionId: "stray", cwd: "/elsewhere", updatedAt: 5 }),
      ],
    );
    const groups = groupByWorkspace(sessions, [workspace]);
    expect(groups.map((group) => group.workspace?.name ?? null)).toEqual(["w", null]);
    expect(groups[0].sessions.map((session) => session.key)).toEqual(["chat:new", "launch:1", "chat:old"]);
    expect(groups[1].sessions.map((session) => session.key)).toEqual(["chat:stray"]);
  });

  it("picks the folder at the workspace root as primary, else the first active one", () => {
    expect(workspaceFolders(workspace).map((folder) => folder.id)).toEqual(["a", "b"]);
    expect(primaryFolder(workspace)?.id).toBe("b");
    expect(primaryFolder({ ...workspace, path: undefined })?.id).toBe("a");
    expect(primaryFolder({ ...workspace, projects: [] })).toBeNull();
  });

  it("uses the workspace root as its working directory, falling back to the primary folder", () => {
    expect(workspaceCwd(workspace)).toBe("/repos/main");
    expect(workspaceCwd({ ...workspace, path: undefined })).toBe("/repos/tools");
    expect(workspaceCwd({ ...workspace, path: undefined, projects: [] })).toBeUndefined();
  });
});
