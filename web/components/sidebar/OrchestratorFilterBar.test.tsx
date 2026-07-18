import i18n from "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrchestratorFilterBar from "./OrchestratorFilterBar";
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

describe("OrchestratorFilterBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    resetOrchestratorFilters();
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it("renders default chip labels when no filter is active", () => {
    render(<OrchestratorFilterBar />);

    expect(screen.getByRole("button", { name: tt("sidebar.workspace") })).toBeVisible();
    expect(screen.getByRole("button", { name: tt("sidebar.project") })).toBeVisible();
    expect(screen.getByPlaceholderText(tt("searchPlaceholder"))).toBeVisible();
    // Role buttons are identified by their title attribute.
    expect(screen.getByTitle(tt("sidebar.allRoles"))).toBeVisible();
    expect(screen.getByTitle("worker")).toBeVisible();
  });

  it("shows the active workspace name on the workspace chip", () => {
    resetOrchestratorFilters();
    useOrchestratorStore.setState({ filterWorkspace: "alpha-ws" });

    render(<OrchestratorFilterBar />);

    expect(screen.getByRole("button", { name: "alpha-ws" })).toBeVisible();
  });

  it("typing in the search box updates the store keyword", async () => {
    const user = userEvent.setup();
    render(<OrchestratorFilterBar />);

    await user.type(screen.getByPlaceholderText(tt("searchPlaceholder")), "hello");

    expect(useOrchestratorStore.getState().searchKeyword).toBe("hello");
  });

  it("clicking a role button sets the filter role in the store", async () => {
    const user = userEvent.setup();
    render(<OrchestratorFilterBar />);

    await user.click(screen.getByTitle("leader"));

    expect(useOrchestratorStore.getState().filterRole).toBe("leader");
  });

  it("clicking the active All-roles button keeps role null", async () => {
    const user = userEvent.setup();
    useOrchestratorStore.setState({ filterRole: "worker" });
    render(<OrchestratorFilterBar />);

    await user.click(screen.getByTitle(tt("sidebar.allRoles")));

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
    render(<OrchestratorFilterBar />);

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
    render(<OrchestratorFilterBar />);

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
    render(<OrchestratorFilterBar />);

    await user.click(screen.getByRole("button", { name: tt("sidebar.project") }));
    // Only ws-one's project should be available.
    expect(screen.queryByRole("button", { name: /other/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /front/ }));

    expect(useOrchestratorStore.getState().filterProjectPath).toBe("/repo/frontend");
  });

  it("shows selected project label on the project chip", () => {
    useWorkspacesStore.setState({
      workspaces: [
        createTestWorkspace({
          name: "ws-one",
          projects: [createTestWorkspaceProject({ alias: "myproj", path: "/repo/myproj" })],
        }),
      ],
    });
    useOrchestratorStore.setState({ filterProjectPath: "/repo/myproj" });
    render(<OrchestratorFilterBar />);

    expect(screen.getByRole("button", { name: "myproj" })).toBeVisible();
  });
});
