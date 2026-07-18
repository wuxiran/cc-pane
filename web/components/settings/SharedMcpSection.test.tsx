import "@/i18n";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { mcpService } from "@/services";
import { useSharedMcpStore } from "@/stores";
import type { SharedMcpServerConfig, SharedMcpServerInfo } from "@/types";
import SharedMcpSection from "./SharedMcpSection";

vi.mock("@/services/mcpService", () => ({
  mcpService: {
    getOrchestratorInfo: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

const tk = (key: string, opts?: Record<string, unknown>) =>
  String(i18n.t(`settings:${key}` as never, opts as never));

const fetchStatusMock = vi.fn(async () => {});
const fetchConfigMock = vi.fn(async () => {});
const startServerMock = vi.fn(async () => {});
const stopServerMock = vi.fn(async () => {});
const restartServerMock = vi.fn(async () => {});
const upsertServerMock = vi.fn(async () => {});
const toggleSharedMock = vi.fn(async () => {});
const removeServerMock = vi.fn(async () => {});
const importFromClaudeMock = vi.fn(async (): Promise<string[]> => []);

function createServer(overrides: {
  name?: string;
  status?: SharedMcpServerInfo["status"];
  config?: Partial<SharedMcpServerConfig>;
} = {}): SharedMcpServerInfo {
  return {
    name: overrides.name ?? "context7",
    status: overrides.status ?? "Stopped",
    config: {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: {},
      shared: true,
      port: 3100,
      bridgeMode: "mcp-proxy",
      ...overrides.config,
    },
  } as SharedMcpServerInfo;
}

function setStore(servers: SharedMcpServerInfo[]) {
  useSharedMcpStore.setState({
    servers,
    config: { portRangeStart: 3100, portRangeEnd: 3199 } as never,
    fetchStatus: fetchStatusMock,
    fetchConfig: fetchConfigMock,
    startServer: startServerMock,
    stopServer: stopServerMock,
    restartServer: restartServerMock,
    upsertServer: upsertServerMock,
    toggleShared: toggleSharedMock,
    removeServer: removeServerMock,
    importFromClaude: importFromClaudeMock,
  });
}

/** render 并 flush 挂载期 CcpanesMcpCard 的异步 setState，避免 act 警告 */
async function renderSection() {
  const result = render(<SharedMcpSection />);
  await act(async () => {});
  return result;
}

async function openNewForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /新增/ }));
}

describe("SharedMcpSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mcpService.getOrchestratorInfo).mockResolvedValue({ port: null, token: "" } as never);
    setStore([]);
  });

  it("fetches status and config on mount and shows the empty state", async () => {
    await renderSection();

    expect(fetchStatusMock).toHaveBeenCalled();
    expect(fetchConfigMock).toHaveBeenCalled();
    expect(screen.getByText("还没有共享 MCP")).toBeInTheDocument();
  });

  it("shows the orchestrator card with url and token when a port is available", async () => {
    vi.mocked(mcpService.getOrchestratorInfo).mockResolvedValue({
      port: 4500,
      token: "tok-123",
    } as never);
    await renderSection();

    expect(
      await screen.findByText("http://127.0.0.1:4500/mcp?token=tok-123"),
    ).toBeInTheDocument();
    expect(screen.getByText("tok-123")).toBeInTheDocument();
  });

  it("hides the orchestrator card when no port is reported", async () => {
    await renderSection();

    await waitFor(() => expect(mcpService.getOrchestratorInfo).toHaveBeenCalled());
    expect(screen.queryByText(/CC-Panes MCP/)).not.toBeInTheDocument();
  });

  it("prefills the next free port from the config range when adding", async () => {
    const user = userEvent.setup();
    setStore([createServer({ config: { port: 3100 } })]);
    await renderSection();

    await openNewForm(user);

    expect(screen.getByPlaceholderText("3100")).toHaveValue("3101");
  });

  it("rejects saving with an empty name or command", async () => {
    const user = userEvent.setup();
    await renderSection();

    await openNewForm(user);
    await user.click(screen.getByRole("button", { name: /保存/ }));

    expect(toast.error).toHaveBeenCalledWith("MCP 名称和命令不能为空");
    expect(upsertServerMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range port", async () => {
    const user = userEvent.setup();
    await renderSection();

    await openNewForm(user);
    await user.type(screen.getByPlaceholderText("context7"), "srv");
    await user.type(screen.getByPlaceholderText("npx"), "npx");
    const portInput = screen.getByPlaceholderText("3100");
    await user.clear(portInput);
    await user.type(portInput, "99999");
    await user.click(screen.getByRole("button", { name: /保存/ }));

    expect(toast.error).toHaveBeenCalledWith("端口必须是 1-65535 之间的数字");
    expect(upsertServerMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate names and duplicate ports", async () => {
    const user = userEvent.setup();
    setStore([createServer({ name: "existing", config: { port: 3100 } })]);
    await renderSection();

    await openNewForm(user);
    await user.type(screen.getByPlaceholderText("context7"), "existing");
    await user.type(screen.getByPlaceholderText("npx"), "npx");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(toast.error).toHaveBeenLastCalledWith("MCP 名称已存在");

    const nameInput = screen.getByPlaceholderText("context7");
    await user.clear(nameInput);
    await user.type(nameInput, "fresh");
    const portInput = screen.getByPlaceholderText("3100");
    await user.clear(portInput);
    await user.type(portInput, "3100");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(toast.error).toHaveBeenLastCalledWith("端口已被其他共享 MCP 使用");

    expect(upsertServerMock).not.toHaveBeenCalled();
  });

  it("saves a valid new server with parsed args and env", async () => {
    const user = userEvent.setup();
    await renderSection();

    await openNewForm(user);
    await user.type(screen.getByPlaceholderText("context7"), " srv ");
    await user.type(screen.getByPlaceholderText("npx"), "npx");
    await user.type(screen.getByPlaceholderText("-y @upstash/context7-mcp"), "-y   pkg");
    await user.type(screen.getByPlaceholderText("KEY=VALUE"), "TOKEN=abc");
    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() =>
      expect(upsertServerMock).toHaveBeenCalledWith("srv", {
        command: "npx",
        args: ["-y", "pkg"],
        env: { TOKEN: "abc" },
        shared: true,
        port: 3100,
        bridgeMode: "mcp-proxy",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("共享 MCP 已新增");
  });

  it("removes the old entry when renaming through the edit form", async () => {
    const user = userEvent.setup();
    setStore([createServer({ name: "old" })]);
    await renderSection();

    await user.click(screen.getByTitle(tk("sharedMcp.edit")));
    const nameInput = screen.getByDisplayValue("old");
    await user.clear(nameInput);
    await user.type(nameInput, "new");
    await user.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => expect(removeServerMock).toHaveBeenCalledWith("old"));
    expect(upsertServerMock).toHaveBeenCalledWith("new", expect.objectContaining({ command: "npx" }));
    expect(toast.success).toHaveBeenCalledWith("共享 MCP 已更新");
  });

  it("shows start only for stopped shared servers and stop/restart only when running", async () => {
    setStore([
      createServer({ name: "stopped-shared", status: "Stopped" }),
      createServer({ name: "running", status: "Running", config: { port: 3101 } }),
      createServer({
        name: "stopped-unshared",
        status: "Stopped",
        config: { shared: false, port: 3102 },
      }),
    ]);
    await renderSection();

    expect(screen.getAllByTitle(tk("sharedMcp.start"))).toHaveLength(1);
    expect(screen.getAllByTitle(tk("sharedMcp.stop"))).toHaveLength(1);
    expect(screen.getAllByTitle(tk("sharedMcp.restart"))).toHaveLength(1);
  });

  it("renders a failed status as a destructive badge with the message", async () => {
    setStore([
      createServer({
        name: "broken",
        status: { Failed: { message: "spawn error" } } as never,
      }),
    ]);
    await renderSection();

    expect(screen.getByText(/Failed: spawn error/)).toBeInTheDocument();
  });

  it("starts, stops, toggles and removes servers through the row actions", async () => {
    const user = userEvent.setup();
    setStore([
      createServer({ name: "stopped", status: "Stopped" }),
      createServer({ name: "running", status: "Running", config: { port: 3101 } }),
    ]);
    await renderSection();

    await user.click(screen.getByTitle(tk("sharedMcp.start")));
    await waitFor(() => expect(startServerMock).toHaveBeenCalledWith("stopped"));

    await user.click(screen.getByTitle(tk("sharedMcp.stop")));
    await waitFor(() => expect(stopServerMock).toHaveBeenCalledWith("running"));

    await user.click(screen.getByTitle(tk("sharedMcp.restart")));
    await waitFor(() => expect(restartServerMock).toHaveBeenCalledWith("running"));

    await user.click(screen.getAllByTitle(tk("sharedMcp.disableSharing"))[0]);
    await waitFor(() => expect(toggleSharedMock).toHaveBeenCalledWith("stopped", false));

    await user.click(screen.getAllByTitle(tk("sharedMcp.remove"))[0]);
    await waitFor(() => expect(removeServerMock).toHaveBeenCalledWith("stopped"));
  });

  it("imports servers from Claude and reports the outcome", async () => {
    const user = userEvent.setup();
    importFromClaudeMock.mockResolvedValueOnce(["a", "b"]);
    await renderSection();

    await user.click(screen.getByRole("button", { name: /导入 MCP 配置/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(tk("sharedMcp.importedCount", { count: 2 })));

    importFromClaudeMock.mockResolvedValueOnce([]);
    await user.click(screen.getByRole("button", { name: /导入 MCP 配置/ }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(tk("sharedMcp.noNewServers")));
  });

  it("polls fetchStatus every 5 seconds", async () => {
    vi.useFakeTimers();
    try {
      await renderSection();
      const initialCalls = fetchStatusMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchStatusMock.mock.calls.length).toBe(initialCalls + 1);

      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchStatusMock.mock.calls.length).toBe(initialCalls + 3);
    } finally {
      vi.useRealTimers();
    }
  });
});
