import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpStore } from "./useMcpStore";
import { mcpService } from "@/services";
import { mcpTargetKey, type McpLayerTarget, type McpServerConfig } from "@/types";

vi.mock("@/services", () => ({ mcpService: {
  listServers: vi.fn(), upsertServer: vi.fn(), removeServer: vi.fn(),
  listLegacyServers: vi.fn(), importLegacyServers: vi.fn(),
} }));

const projectA = { projectPath: "/project/a" } as const;
const projectB = { projectPath: "/project/b" } as const;
const workspace = { workspaceName: "team" } as const;
const servers = (command: string): Record<string, McpServerConfig> => ({
  shared: { command, args: [], env: {} },
});
const layer = (target: McpLayerTarget) => useMcpStore.getState().layers[mcpTargetKey(target)];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useMcpStore.getState().clear();
  vi.mocked(mcpService.listServers).mockResolvedValue({});
  vi.mocked(mcpService.listLegacyServers).mockResolvedValue({});
});

describe("MCP layers", () => {
  it("keeps project and workspace data and loading state independent", async () => {
    const pending = deferred<Record<string, McpServerConfig>>();
    vi.mocked(mcpService.listServers).mockImplementation((target) =>
      mcpTargetKey(target) === mcpTargetKey(projectA) ? pending.promise : Promise.resolve(servers(mcpTargetKey(target))));
    const loadA = useMcpStore.getState().loadServers(projectA);
    await useMcpStore.getState().loadServers(projectB);
    await useMcpStore.getState().loadServers(workspace);
    expect(layer(projectA).loading).toBe(true);
    expect(layer(projectB).servers.shared.command).toBe(mcpTargetKey(projectB));
    expect(layer(workspace).servers.shared.command).toBe(mcpTargetKey(workspace));
    pending.resolve(servers("a"));
    await loadA;
    expect(layer(projectA)).toMatchObject({ loading: false, servers: servers("a") });
    expect(layer(projectB).servers.shared.command).toBe(mcpTargetKey(projectB));
  });

  it.each(["success", "failure"] as const)("ignores an older same-target %s after a newer read", async (outcome) => {
    const old = deferred<Record<string, McpServerConfig>>();
    vi.mocked(mcpService.listServers).mockReturnValueOnce(old.promise).mockResolvedValueOnce(servers("latest"));
    const first = useMcpStore.getState().loadServers(projectA);
    await useMcpStore.getState().loadServers(projectA);
    if (outcome === "success") old.resolve(servers("old"));
    else old.reject(new Error("obsolete failure"));
    await first;
    expect(layer(projectA)).toMatchObject({ servers: servers("latest"), error: null, loading: false });
  });

  it("reports a current load failure only on its own target", async () => {
    vi.mocked(mcpService.listServers).mockResolvedValueOnce(servers("b")).mockRejectedValueOnce(new Error("load failed"));
    await useMcpStore.getState().loadServers(projectB);
    await useMcpStore.getState().loadServers(projectA);
    expect(layer(projectA).error).toContain("load failed");
    expect(layer(projectA).loading).toBe(false);
    expect(layer(projectB)).toMatchObject({ servers: servers("b"), error: null });
  });

  it("a mutation refresh supersedes pending reads of that target and leaves other targets intact", async () => {
    const stale = deferred<Record<string, McpServerConfig>>();
    vi.mocked(mcpService.listServers).mockResolvedValueOnce(servers("b")).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(servers("updated-a"));
    await useMcpStore.getState().loadServers(projectB);
    const beforeWrite = useMcpStore.getState().loadServers(projectA);
    await useMcpStore.getState().upsertServer(projectA, "shared", "updated-a", [], {});
    stale.resolve(servers("old-a"));
    await beforeWrite;
    expect(mcpService.upsertServer).toHaveBeenCalledWith(projectA, "shared", "updated-a", [], {}, undefined);
    expect(layer(projectA).servers).toEqual(servers("updated-a"));
    expect(layer(projectB).servers).toEqual(servers("b"));
  });

  it("a pending mutation refresh stays in its target while another target loads", async () => {
    const refresh = deferred<Record<string, McpServerConfig>>();
    vi.mocked(mcpService.listServers).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(servers("b"));
    const mutation = useMcpStore.getState().upsertServer(projectA, "shared", "a", [], {});
    await vi.waitFor(() => expect(mcpService.listServers).toHaveBeenCalledWith(projectA));
    await useMcpStore.getState().loadServers(projectB);
    refresh.resolve(servers("a"));
    await mutation;
    expect(layer(projectA).servers).toEqual(servers("a"));
    expect(layer(projectB).servers).toEqual(servers("b"));
  });

  it("refreshes the removed layer, but skips a no-op removal", async () => {
    vi.mocked(mcpService.removeServer).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await useMcpStore.getState().removeServer(projectA, "missing")).toBe(false);
    expect(mcpService.listServers).not.toHaveBeenCalled();
    expect(await useMcpStore.getState().removeServer(projectB, "shared")).toBe(true);
    expect(mcpService.listServers).toHaveBeenCalledExactlyOnceWith(projectB);
    expect(layer(projectB).servers).toEqual({});
  });

  it("retains a refresh error and propagates it after a successful mutation", async () => {
    vi.mocked(mcpService.listServers).mockRejectedValue(new Error("refresh failed"));
    await expect(useMcpStore.getState().upsertServer(projectA, "shared", "a", [], {})).rejects.toThrow("refresh failed");
    expect(layer(projectA).error).toContain("refresh failed");
  });

  it("isolates legacy lists and ignores stale legacy results", async () => {
    const old = deferred<Record<string, McpServerConfig>>();
    vi.mocked(mcpService.listLegacyServers).mockReturnValueOnce(old.promise).mockResolvedValueOnce(servers("legacy-b")).mockResolvedValueOnce(servers("latest-a"));
    const first = useMcpStore.getState().loadLegacyServers(projectA.projectPath);
    await useMcpStore.getState().loadLegacyServers(projectB.projectPath);
    await useMcpStore.getState().loadLegacyServers(projectA.projectPath);
    old.resolve(servers("old-a"));
    await first;
    expect(layer(projectA).legacyServers).toEqual(servers("latest-a"));
    expect(layer(projectB).legacyServers).toEqual(servers("legacy-b"));
  });

  it("legacy read failure clears only that project's legacy list", async () => {
    vi.mocked(mcpService.listLegacyServers).mockResolvedValueOnce(servers("b")).mockRejectedValueOnce(new Error("missing"));
    await useMcpStore.getState().loadLegacyServers(projectB.projectPath);
    await useMcpStore.getState().loadLegacyServers(projectA.projectPath);
    expect(layer(projectA).legacyServers).toEqual({});
    expect(layer(projectB).legacyServers).toEqual(servers("b"));
  });

  it("import refreshes its destination workspace or project, and skips an empty import", async () => {
    vi.mocked(mcpService.importLegacyServers).mockResolvedValueOnce([]).mockResolvedValueOnce(["one"]).mockResolvedValueOnce(["two"]);
    await useMcpStore.getState().importLegacyServers(projectA.projectPath);
    expect(mcpService.listServers).not.toHaveBeenCalled();
    await useMcpStore.getState().importLegacyServers(projectA.projectPath, "team");
    await useMcpStore.getState().importLegacyServers(projectB.projectPath);
    expect(vi.mocked(mcpService.listServers).mock.calls).toEqual([[workspace], [projectB]]);
  });

  it("clear invalidates pending server/legacy reads and mutation completions", async () => {
    const read = deferred<Record<string, McpServerConfig>>();
    const legacy = deferred<Record<string, McpServerConfig>>();
    const write = deferred<void>();
    vi.mocked(mcpService.listServers).mockReturnValue(read.promise);
    vi.mocked(mcpService.listLegacyServers).mockReturnValue(legacy.promise);
    vi.mocked(mcpService.upsertServer).mockReturnValue(write.promise);
    const jobs = [
      useMcpStore.getState().loadServers(projectA),
      useMcpStore.getState().loadLegacyServers(projectB.projectPath),
      useMcpStore.getState().upsertServer(workspace, "shared", "a", [], {}),
    ];
    useMcpStore.getState().clear();
    read.resolve(servers("a")); legacy.resolve(servers("b")); write.resolve();
    await Promise.all(jobs);
    expect(useMcpStore.getState().layers).toEqual({});
    expect(mcpService.listServers).toHaveBeenCalledTimes(1);
  });
});
