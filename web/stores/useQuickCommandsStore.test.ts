import { beforeEach, describe, expect, it, vi } from "vitest";
import { quickCommandService } from "@/services/quickCommandService";
import type { QuickCommand, QuickCommandDraft } from "@/types";
import { useQuickCommandsStore } from "./useQuickCommandsStore";

vi.mock("@/services/quickCommandService", () => ({
  quickCommandService: {
    listGlobal: vi.fn(),
    createGlobal: vi.fn(),
    updateGlobal: vi.fn(),
    deleteGlobal: vi.fn(),
    listProject: vi.fn(),
    saveProject: vi.fn(),
    listWorkspace: vi.fn(),
    saveWorkspace: vi.fn(),
  },
}));

const service = vi.mocked(quickCommandService);

function command(id: string, name = id): QuickCommand {
  return {
    id,
    name,
    kind: "terminal",
    text: "cargo test",
    appendEnter: true,
    target: "currentPane",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}

const draft: QuickCommandDraft = {
  name: "Run tests",
  kind: "terminal",
  text: "cargo test",
  appendEnter: true,
  target: "currentPane",
};

describe("useQuickCommandsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listWorkspace.mockResolvedValue([]);
    useQuickCommandsStore.setState({
      globalCommands: [],
      workspaceCommands: [],
      projectCommands: [],
      commands: [],
      activeProjectPath: null,
      activeWorkspaceName: null,
      loading: false,
    });
  });

  it("合并全局与当前项目命令并标记 scope", async () => {
    service.listGlobal.mockResolvedValue([command("global")]);
    service.listProject.mockResolvedValue([command("project")]);

    await useQuickCommandsStore.getState().load("/repo/a");

    expect(service.listProject).toHaveBeenCalledWith("/repo/a");
    expect(service.listWorkspace).not.toHaveBeenCalled();
    expect(useQuickCommandsStore.getState().commands).toEqual([
      { ...command("global"), scope: "global" },
      { ...command("project"), scope: "project" },
    ]);
  });

  it("带工作空间上下文时加载三层，顺序 global → workspace → project", async () => {
    service.listGlobal.mockResolvedValue([command("global")]);
    service.listWorkspace.mockResolvedValue([command("ws")]);
    service.listProject.mockResolvedValue([command("project")]);

    await useQuickCommandsStore.getState().load({ projectPath: "/repo/a", workspaceName: "alpha" });

    expect(service.listWorkspace).toHaveBeenCalledWith("alpha");
    const state = useQuickCommandsStore.getState();
    expect(state.activeWorkspaceName).toBe("alpha");
    expect(state.commands.map((c) => `${c.scope}:${c.id}`)).toEqual([
      "global:global",
      "workspace:ws",
      "project:project",
    ]);
  });

  it("workspace 层的增改删是整文件读改写", async () => {
    service.listGlobal.mockResolvedValue([]);
    service.listWorkspace.mockResolvedValue([command("ws-1")]);
    service.saveWorkspace.mockImplementation(async (_name, commands) => commands);
    await useQuickCommandsStore.getState().load({ workspaceName: "alpha" });

    const created = await useQuickCommandsStore.getState().create(draft, "workspace");
    expect(created.scope).toBe("workspace");
    expect(service.saveWorkspace).toHaveBeenLastCalledWith(
      "alpha",
      expect.arrayContaining([expect.objectContaining({ id: "ws-1" }), expect.objectContaining({ name: "Run tests" })]),
    );

    const lastSaved = (): QuickCommand[] => {
      const calls = service.saveWorkspace.mock.calls;
      return calls[calls.length - 1][1];
    };
    await useQuickCommandsStore.getState().update("ws-1", { ...draft, name: "Renamed" }, "workspace");
    expect(lastSaved().find((c) => c.id === "ws-1")?.name).toBe("Renamed");

    await useQuickCommandsStore.getState().remove("ws-1", "workspace");
    expect(lastSaved().some((c) => c.id === "ws-1")).toBe(false);
    expect(useQuickCommandsStore.getState().commands.every((c) => c.id !== "ws-1")).toBe(true);
  });

  it("没有活跃工作空间时拒绝写 workspace 层", async () => {
    await expect(useQuickCommandsStore.getState().create(draft, "workspace")).rejects.toThrow(/workspace/i);
  });

  it("无激活项目时只保留全局命令", async () => {
    service.listGlobal.mockResolvedValue([command("global")]);

    await useQuickCommandsStore.getState().load();

    expect(service.listProject).not.toHaveBeenCalled();
    expect(useQuickCommandsStore.getState().commands).toEqual([
      { ...command("global"), scope: "global" },
    ]);
  });

  it("切换项目时立即清除上一个项目的命令", async () => {
    let resolveProject: ((commands: QuickCommand[]) => void) | undefined;
    const previousGlobal = command("global");
    const previousProject = command("project-a");
    useQuickCommandsStore.setState({
      globalCommands: [previousGlobal],
      projectCommands: [previousProject],
      commands: [
        { ...previousGlobal, scope: "global" },
        { ...previousProject, scope: "project" },
      ],
      activeProjectPath: "/repo/a",
    });
    service.listGlobal.mockResolvedValue([previousGlobal]);
    service.listProject.mockImplementation(() => new Promise((resolve) => {
      resolveProject = resolve;
    }));

    const loading = useQuickCommandsStore.getState().load("/repo/b");

    expect(useQuickCommandsStore.getState()).toMatchObject({
      activeProjectPath: "/repo/b",
      projectCommands: [],
      commands: [{ ...previousGlobal, scope: "global" }],
      loading: true,
    });

    resolveProject?.([command("project-b")]);
    await loading;
    expect(useQuickCommandsStore.getState().commands).toContainEqual({
      ...command("project-b"),
      scope: "project",
    });
  });

  it("项目加载失败时不恢复上一个项目的命令", async () => {
    const previousGlobal = command("global");
    const previousProject = command("project-a");
    useQuickCommandsStore.setState({
      globalCommands: [previousGlobal],
      projectCommands: [previousProject],
      commands: [
        { ...previousGlobal, scope: "global" },
        { ...previousProject, scope: "project" },
      ],
      activeProjectPath: "/repo/a",
    });
    service.listGlobal.mockResolvedValue([previousGlobal]);
    service.listProject.mockRejectedValue(new Error("broken project config"));

    await expect(useQuickCommandsStore.getState().load("/repo/b")).rejects.toThrow(
      "broken project config",
    );

    expect(useQuickCommandsStore.getState()).toMatchObject({
      activeProjectPath: "/repo/b",
      projectCommands: [],
      commands: [{ ...previousGlobal, scope: "global" }],
      loading: false,
    });
  });

  it("创建项目命令时保存项目完整列表", async () => {
    service.saveProject.mockImplementation(async (_path, commands) => commands);

    const created = await useQuickCommandsStore
      .getState()
      .create(draft, "project", "/repo/a");

    expect(created.scope).toBe("project");
    expect(service.saveProject).toHaveBeenCalledWith(
      "/repo/a",
      [expect.objectContaining({ name: "Run tests", id: expect.any(String) })],
    );
    expect(useQuickCommandsStore.getState().projectCommands).toHaveLength(1);
  });

  it("更新全局命令后同步合并视图", async () => {
    const existing = command("global");
    const updated = { ...existing, name: "Focused" };
    useQuickCommandsStore.setState({
      globalCommands: [existing],
      commands: [{ ...existing, scope: "global" }],
    });
    service.updateGlobal.mockResolvedValue(updated);

    await useQuickCommandsStore
      .getState()
      .update("global", { ...draft, name: "Focused" }, "global");

    expect(service.updateGlobal).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({ name: "Focused" }),
    );
    expect(useQuickCommandsStore.getState().commands[0].name).toBe("Focused");
  });

  it("删除项目命令时只保存剩余项目列表", async () => {
    const first = command("first");
    const second = command("second");
    useQuickCommandsStore.setState({
      activeProjectPath: "/repo/a",
      projectCommands: [first, second],
      commands: [
        { ...first, scope: "project" },
        { ...second, scope: "project" },
      ],
    });
    service.saveProject.mockResolvedValue([second]);

    await useQuickCommandsStore.getState().remove("first", "project");

    expect(service.saveProject).toHaveBeenCalledWith("/repo/a", [second]);
    expect(useQuickCommandsStore.getState().projectCommands).toEqual([second]);
  });
});
