import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";
import StartProjectMenu, { workspaceLabelFor } from "./StartProjectMenu";

function workspace(patch: Partial<Workspace>): Workspace {
  return {
    id: patch.name ?? "ws",
    name: "ws",
    createdAt: "2026-01-01T00:00:00Z",
    projects: [],
    ...patch,
  } as Workspace;
}

describe("StartProjectMenu", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [
        workspace({
          name: "team",
          path: "D:/work/team",
          projects: [{ id: "p1", path: "D:/work/team/app", addedAt: "" } as Workspace["projects"][number]],
        }),
        // 默认工作空间的 path 是数据目录，不可选；但其项目照常列出
        workspace({
          name: "default",
          isDefault: true,
          path: "C:/Users/me/.cc-panes",
          projects: [{ id: "p2", path: "D:/solo", addedAt: "" } as Workspace["projects"][number]],
        }),
        // 无项目但有根目录的工作空间也要出现（可选中根目录）
        workspace({ name: "empty-root", path: "D:/work/empty" }),
      ],
    });
  });

  it("工作空间有根目录时可直接选中，默认工作空间只作分组标题", async () => {
    const user = userEvent.setup();
    const onPickCwd = vi.fn();
    render(<StartProjectMenu cwd="" onPickCwd={onPickCwd} trigger={<button type="button">open</button>} />);
    await user.click(screen.getByText("open"));

    const teamItem = await screen.findByText("team");
    expect(teamItem.closest("[role=menuitem]")).not.toBeNull();
    expect(screen.getByText("default").closest("[role=menuitem]")).toBeNull();
    expect(screen.getByText("empty-root").closest("[role=menuitem]")).not.toBeNull();

    await user.click(teamItem);
    expect(onPickCwd).toHaveBeenCalledWith("D:/work/team");
  });

  it("选项目仍回传项目路径", async () => {
    const user = userEvent.setup();
    const onPickCwd = vi.fn();
    render(<StartProjectMenu cwd="" onPickCwd={onPickCwd} trigger={<button type="button">open</button>} />);
    await user.click(screen.getByText("open"));
    await user.click(await screen.findByText("solo"));
    expect(onPickCwd).toHaveBeenCalledWith("D:/solo");
  });
});

describe("workspaceLabelFor", () => {
  const list = [
    workspace({
      name: "team",
      alias: "团队",
      path: "D:/work/team",
      projects: [{ id: "p1", path: "D:/work/team/app", addedAt: "" } as Workspace["projects"][number]],
    }),
    workspace({ name: "archived", archivedAt: "2026-01-02T00:00:00Z", path: "D:/work/old" }),
  ];

  it("命中工作空间根目录或其下项目 → 工作空间名（alias 优先）", () => {
    expect(workspaceLabelFor("D:/work/team", list)).toBe("团队");
    expect(workspaceLabelFor("D:/work/team/app", list)).toBe("团队");
  });

  it("大小写/分隔符差异视为同路径", () => {
    expect(workspaceLabelFor("d:\\work\\team\\app", list)).toBe("团队");
  });

  it("归档工作空间不参与归属，退回目录名", () => {
    expect(workspaceLabelFor("D:/work/old", list)).toBe("old");
  });

  it("未注册目录退回目录名，空 cwd 返回空串", () => {
    expect(workspaceLabelFor("C:/tmp/x", list)).toBe("x");
    expect(workspaceLabelFor("", list)).toBe("");
  });

  it("Agent Chat 常驻工作空间用产品名展示，而不是目录名 agent-chat", () => {
    const withResident = [
      ...list,
      workspace({ name: "agent-chat", isAgentChat: true, path: "D:/data/agent-chat" }),
    ];
    expect(workspaceLabelFor("D:/data/agent-chat", withResident)).toBe("Agent Chat");
    // alias 仍然优先
    const aliased = [
      workspace({
        name: "agent-chat",
        isAgentChat: true,
        alias: "聊天台",
        path: "D:/data/agent-chat",
      }),
    ];
    expect(workspaceLabelFor("D:/data/agent-chat", aliased)).toBe("聊天台");
  });
});
