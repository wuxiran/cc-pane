import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorFilterButton, OrchestratorSearchField } from "./OrchestratorFilterBar";
import { useOrchestratorStore, useWorkspacesStore } from "@/stores";
import {
  createTestWorkspace,
  createTestWorkspaceProject,
  resetTestDataCounter,
} from "@/test/utils/testData";

// The orchestrator store's filter setters call loadBindings() -> taskBindingService.query.
// Stub it so it resolves quietly and never hits the (mocked-but-unhandled) invoke.
vi.mock("@/services", () => ({
  taskBindingService: {
    query: vi.fn(async () => ({ items: [], total: 0, hasMore: false })),
  },
}));

const tt = (k: string) => String(i18n.t(`orchestration:${k}` as never));

function resetOrchestratorFilters() {
  useOrchestratorStore.setState({
    bindings: [],
    filterWorkspace: null,
    filterProjectPath: null,
    filterRole: null,
    searchKeyword: "",
  });
}

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  render(<OrchestratorFilterButton />);
  await user.click(screen.getByRole("button", { name: tt("sidebar.filters") }));
}

describe("OrchestratorFilterButton / OrchestratorSearchField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    resetOrchestratorFilters();
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it("keeps workspace / project / role filters inside the filter popover", async () => {
    const user = userEvent.setup();
    render(<OrchestratorFilterButton />);

    expect(screen.queryByRole("button", { name: tt("sidebar.workspace") })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tt("sidebar.filters") }));

    expect(screen.getByRole("button", { name: tt("sidebar.workspace") })).toBeVisible();
    expect(screen.getByRole("button", { name: tt("sidebar.project") })).toBeVisible();
    expect(screen.getByRole("tablist", { name: tt("sidebar.allRoles") })).toBeVisible();
    expect(screen.getByRole("tab", { name: tt("role.worker") })).toBeVisible();
    // Role options are text labels, not emoji glyphs.
    expect(screen.getByRole("tablist").textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2699}]/u);
  });

  it("shows the active workspace name on the workspace chip", async () => {
    const user = userEvent.setup();
    useOrchestratorStore.setState({ filterWorkspace: "alpha-ws" });

    await openFilters(user);

    expect(screen.getByRole("button", { name: "alpha-ws" })).toBeVisible();
  });

  it("typing in the search box updates the store keyword", async () => {
    const user = userEvent.setup();
    render(<OrchestratorSearchField onClose={vi.fn()} />);

    const input = screen.getByPlaceholderText(tt("searchPlaceholder"));
    expect(input).toHaveFocus();
    await user.type(input, "hello");

    expect(useOrchestratorStore.getState().searchKeyword).toBe("hello");
  });

  it("closing the search field clears the keyword", () => {
    const onClose = vi.fn();
    useOrchestratorStore.setState({ searchKeyword: "abc" });
    render(<OrchestratorSearchField onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: tt("sidebar.closeSearch") }));

    expect(useOrchestratorStore.getState().searchKeyword).toBe("");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking a role tab sets the filter role in the store", async () => {
    const user = userEvent.setup();
    await openFilters(user);

    await user.click(screen.getByRole("tab", { name: tt("role.leader") }));

    expect(useOrchestratorStore.getState().filterRole).toBe("leader");
  });

  it("clicking the All-roles tab resets role to null", async () => {
    const user = userEvent.setup();
    useOrchestratorStore.setState({ filterRole: "worker" });
    await openFilters(user);

    await user.click(screen.getByRole("tab", { name: tt("sidebar.roleAll") }));

    expect(useOrchestratorStore.getState().filterRole).toBeNull();
  });

  it("selecting a workspace from the popover sets filterWorkspace", async () => {
    const user = userEvent.setup();
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({ name: "ws-one", alias: "One" }),
        createTestWorkspace({ name: "ws-two" }),
      ],
    });
    await openFilters(user);

    await user.click(screen.getByRole("button", { name: tt("sidebar.workspace") }));
    // Alias is shown when present.
    await user.click(await screen.findByRole("button", { name: "One" }));

    expect(useOrchestratorStore.getState().filterWorkspace).toBe("ws-one");
  });

  it("resets workspace filter via All workspaces option", async () => {
    const user = userEvent.setup();
    useOrchestratorStore.setState({ filterWorkspace: "ws-one" });
    useWorkspacesStore.setState({
      workspaces: [createTestWorkspace({ name: "ws-one" })],
    });
    await openFilters(user);

    await user.click(screen.getByRole("button", { name: "ws-one" }));
    await user.click(await screen.findByRole("button", { name: tt("sidebar.allWorkspaces") }));

    expect(useOrchestratorStore.getState().filterWorkspace).toBeNull();
  });

  it("lists projects of the selected workspace and sets filterProjectPath", async () => {
    const user = userEvent.setup();
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({
          name: "ws-one",
          projects: [
            createTestWorkspaceProject({ alias: "front", path: "/repo/frontend" }),
          ],
        }),
        createTestWorkspace({
          name: "ws-two",
          projects: [createTestWorkspaceProject({ alias: "other", path: "/repo/other" })],
        }),
      ],
    });
    useOrchestratorStore.setState({ filterWorkspace: "ws-one" });
    await openFilters(user);

    await user.click(screen.getByRole("button", { name: tt("sidebar.project") }));
    // Only ws-one's project should be available.
    expect(screen.queryByRole("button", { name: /other/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /front/ }));

    expect(useOrchestratorStore.getState().filterProjectPath).toBe("/repo/frontend");
  });

  it("shows selected project label on the project chip", async () => {
    const user = userEvent.setup();
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({
          name: "ws-one",
          projects: [createTestWorkspaceProject({ alias: "myproj", path: "/repo/myproj" })],
        }),
      ],
    });
    useOrchestratorStore.setState({ filterProjectPath: "/repo/myproj" });
    await openFilters(user);

    expect(screen.getByRole("button", { name: "myproj" })).toBeVisible();
  });
});
