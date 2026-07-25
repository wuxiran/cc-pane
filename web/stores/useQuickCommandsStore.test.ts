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
    useQuickCommandsStore.setState({
      globalCommands: [],
      projectCommands: [],
      commands: [],
      activeProjectPath: null,
      loading: false,
    });
  });

  it("合并全局与当前项目命令并标记 scope", async () => {
    service.listGlobal.mockResolvedValue([command("global")]);
    service.listProject.mockResolvedValue([command("project")]);

    await useQuickCommandsStore.getState().load("/repo/a");

    expect(service.listProject).toHaveBeenCalledWith("/repo/a");
    expect(useQuickCommandsStore.getState().commands).toEqual([
      { ...command("global"), scope: "global" },
      { ...command("project"), scope: "project" },
    ]);
  });

  it("无激活项目时只保留全局命令", async () => {
    service.listGlobal.mockResolvedValue([command("global")]);

    await useQuickCommandsStore.getState().load();

    expect(service.listProject).not.toHaveBeenCalled();
    expect(useQuickCommandsStore.getState().commands).toEqual([
      { ...command("global"), scope: "global" },
    ]);
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
