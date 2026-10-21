import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useMcpStore, useWorkspacesStore } from "@/stores";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import type { McpLayerTarget, McpServerConfig } from "@/types";
import ProjectMcpSection from "./ProjectMcpSection";

const io = vi.hoisted(() => ({
  layers: {} as Record<string, Record<string, McpServerConfig>>,
  list: vi.fn(), upsert: vi.fn(),
}));
vi.mock("@/services/mcpService", () => ({ mcpService: {
  listServers: io.list,
  listLegacyServers: async () => ({}),
  upsertServer: io.upsert,
} }));

const targetA = { projectPath: "/project-a" } as const;
const targetB = { projectPath: "/project-b" } as const;
const editLabel = i18n.t("settings:mcpEdit");
const saveLabel = i18n.t("common:save");
const commandLabel = i18n.t("settings:mcpCommand");

beforeEach(() => {
  vi.resetAllMocks();
  io.layers = {
    "/project-a": { database: { command: "server-a", args: [], env: { TOKEN: "key-for-a" } } },
    "/project-b": { database: { command: "server-b", args: [], env: { TOKEN: "key-for-b" } } },
  };
  io.list.mockImplementation(async (target: McpLayerTarget) => structuredClone(io.layers[target.projectPath!]));
  io.upsert.mockImplementation(async (target, name, command, args, env) => {
    io.layers[target.projectPath][name] = { command, args, env };
  });
  useMcpStore.getState().clear();
  useWorkspacesStore.setState({ workspaces: [] });
  useLaunchProfilesStore.setState({ profiles: [], load: vi.fn(async () => {}) });
  useSharedMcpStore.setState({ servers: [], fetchStatus: vi.fn(async () => {}) });
});

describe("MCP configuration target ownership", () => {
  it("keeps same-named servers isolated in simultaneously mounted tabs, including after save refresh", async () => {
    render(<div data-testid="a"><ProjectMcpSection projectPath={targetA.projectPath} /></div>);
    await within(screen.getByTestId("a")).findByText("server-a");
    render(<div data-testid="b"><ProjectMcpSection projectPath={targetB.projectPath} /></div>);
    await within(screen.getByTestId("b")).findByText("server-b");
    expect(within(screen.getByTestId("a")).getByText("server-a")).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("a")).getByRole("button", { name: editLabel }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(commandLabel), { target: { value: "updated-a" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(io.upsert).toHaveBeenCalledWith(targetA, "database", "updated-a", [], { TOKEN: "key-for-a" }, expect.anything()));
    await within(screen.getByTestId("a")).findByText("updated-a");
    expect(within(screen.getByTestId("b")).getByText("server-b")).toBeInTheDocument();
    expect(io.layers[targetB.projectPath].database.env.TOKEN).toBe("key-for-b");
  });

  it("keeps both displayed configurations correct when the first target responds last", async () => {
    let finish!: (servers: Record<string, McpServerConfig>) => void;
    io.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<div data-testid="a"><ProjectMcpSection projectPath={targetA.projectPath} /></div>);
    render(<div data-testid="b"><ProjectMcpSection projectPath={targetB.projectPath} /></div>);
    await within(screen.getByTestId("b")).findByText("server-b");
    await act(async () => { finish(io.layers[targetA.projectPath]); });
    expect(within(screen.getByTestId("a")).getByText("server-a")).toBeInTheDocument();
    expect(within(screen.getByTestId("b")).getByText("server-b")).toBeInTheDocument();
  });

  it("closes an old target's form instead of carrying its edits into a replacement target", async () => {
    const view = render(<ProjectMcpSection projectPath={targetA.projectPath} />);
    fireEvent.click(await screen.findByRole("button", { name: editLabel }));
    fireEvent.change(screen.getByLabelText(commandLabel), { target: { value: "unsaved-a" } });
    view.rerender(<ProjectMcpSection projectPath={targetB.projectPath} />);
    await screen.findByText("server-b");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: editLabel }));
    expect(screen.getByLabelText(commandLabel)).toHaveValue("server-b");
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(io.upsert).toHaveBeenCalledWith(targetB, "database", "server-b", [], { TOKEN: "key-for-b" }, expect.anything()));
  });

  it("binds a pending save to its original target and does not dismiss a newer target's form", async () => {
    let finish!: () => void;
    io.upsert.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const view = render(<ProjectMcpSection projectPath={targetA.projectPath} />);
    fireEvent.click(await screen.findByRole("button", { name: editLabel }));
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(io.upsert).toHaveBeenCalledTimes(1));
    view.rerender(<ProjectMcpSection projectPath={targetB.projectPath} />);
    await screen.findByText("server-b");
    fireEvent.click(screen.getByRole("button", { name: editLabel }));
    fireEvent.change(screen.getByLabelText(commandLabel), { target: { value: "unsaved-b" } });
    await act(async () => { finish(); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(commandLabel)).toHaveValue("unsaved-b");
    expect(io.upsert.mock.calls[0][0]).toEqual(targetA);
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(io.upsert).toHaveBeenLastCalledWith(targetB, "database", "unsaved-b", [], { TOKEN: "key-for-b" }, expect.anything()));
  });
});
