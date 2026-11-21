import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";
import HomeSetupDialogs from "./HomeSetupDialogs";
import { openHomeCreateWorkspace, openHomeImportProject, useHomeSetupDialogStore } from "./homeSetupDialogStore";

function workspace(id: string, name: string): Workspace {
  return { id, name, projects: [], createdAt: "" } as unknown as Workspace;
}

const create = vi.fn(async (name: string) => workspace("ws-new", name));
const addProject = vi.fn(async () => ({ id: "p1", path: "/code/app" }));

beforeEach(() => {
  vi.clearAllMocks();
  useHomeSetupDialogStore.setState({ mode: null, workspaceId: null });
  useWorkspacesStore.setState({
    workspaces: [workspace("ws-a", "Alpha")],
    expandedWorkspaceId: null,
    create,
    addProject,
  } as never);
});

describe("HomeSetupDialogs", () => {
  it("creates a workspace in place and moves straight on to importing into it", async () => {
    const user = userEvent.setup();
    render(<HomeSetupDialogs />);
    openHomeCreateWorkspace();

    await user.type(await screen.findByLabelText(/名称|Name/), "Beta");
    await user.click(screen.getByRole("button", { name: /创建，下一步|Create, then/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("Beta", undefined));
    expect(useHomeSetupDialogStore.getState()).toMatchObject({ mode: "project", workspaceId: "ws-new" });
  });

  it("imports a project folder into the chosen workspace and closes", async () => {
    const user = userEvent.setup();
    render(<HomeSetupDialogs />);
    openHomeImportProject();

    await user.type(await screen.findByLabelText(/项目目录|Project folder/), "/code/app");
    await user.click(screen.getByRole("button", { name: /^(导入|Import)$/ }));
    await waitFor(() => expect(addProject).toHaveBeenCalledWith("Alpha", "/code/app"));
    expect(useHomeSetupDialogStore.getState().mode).toBeNull();
  });

  it("asks to create a workspace first when there is none", async () => {
    const user = userEvent.setup();
    useWorkspacesStore.setState({ workspaces: [] } as never);
    render(<HomeSetupDialogs />);
    openHomeImportProject();

    await user.click(await screen.findByRole("button", { name: /新建工作空间|New workspace/ }));
    expect(useHomeSetupDialogStore.getState().mode).toBe("workspace");
  });
});
