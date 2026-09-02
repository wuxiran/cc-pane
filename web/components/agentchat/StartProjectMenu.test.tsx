import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";
import StartProjectMenu from "./StartProjectMenu";

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
