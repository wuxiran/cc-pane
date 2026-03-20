import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMcpStore } from "./useMcpStore";
import { mcpService } from "@/services";
import type { McpServerConfig } from "@/types";

vi.mock("@/services", () => ({
  mcpService: {
    listServers: vi.fn(),
    upsertServer: vi.fn(),
    removeServer: vi.fn(),
  },
}));

const mockServers: Record<string, McpServerConfig> = {
  server1: { command: "node", args: ["server.js"], env: {} },
  server2: { command: "python", args: ["main.py"], env: { KEY: "val" } },
};

describe("useMcpStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMcpStore.setState({
      servers: {},
      projectPath: null,
      loading: false,
      error: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useMcpStore.getState();
      expect(state.servers).toEqual({});
      expect(state.projectPath).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("loadServers", () => {
    it("成功时应加载服务器列表", async () => {
      vi.mocked(mcpService.listServers).mockResolvedValue(mockServers);

      await useMcpStore.getState().loadServers("/project/a");

      const state = useMcpStore.getState();
      expect(state.servers).toEqual(mockServers);
      expect(state.projectPath).toBe("/project/a");
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("加载期间 loading 应为 true", async () => {
      vi.mocked(mcpService.listServers).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({}), 10))
      );

      const loadPromise = useMcpStore.getState().loadServers("/project/a");
      expect(useMcpStore.getState().loading).toBe(true);

      await loadPromise;
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it("失败时应设置 error", async () => {
      vi.mocked(mcpService.listServers).mockRejectedValue(
        new Error("load failed")
      );

      await useMcpStore.getState().loadServers("/project/a");

      const state = useMcpStore.getState();
      expect(state.error).toContain("load failed");
      expect(state.loading).toBe(false);
    });
  });

  describe("upsertServer", () => {
    it("路径匹配时应重新加载服务器列表", async () => {
      useMcpStore.setState({ projectPath: "/project/a" });
      vi.mocked(mcpService.upsertServer).mockResolvedValue();
      vi.mocked(mcpService.listServers).mockResolvedValue(mockServers);

      await useMcpStore.getState().upsertServer(
        "/project/a",
        "server1",
        "node",
        ["server.js"],
        {}
      );

      expect(mcpService.upsertServer).toHaveBeenCalledWith(
        "/project/a",
        "server1",
        "node",
        ["server.js"],
        {}
      );
      expect(mcpService.listServers).toHaveBeenCalledWith("/project/a");
      expect(useMcpStore.getState().servers).toEqual(mockServers);
    });

    it("路径不匹配时不应重新加载", async () => {
      useMcpStore.setState({ projectPath: "/project/b" });
      vi.mocked(mcpService.upsertServer).mockResolvedValue();

      await useMcpStore.getState().upsertServer(
        "/project/a",
        "server1",
        "node",
        [],
        {}
      );

      expect(mcpService.upsertServer).toHaveBeenCalled();
      expect(mcpService.listServers).not.toHaveBeenCalled();
    });
  });

  describe("removeServer", () => {
    it("删除成功且路径匹配时应重新加载", async () => {
      useMcpStore.setState({ projectPath: "/project/a" });
      vi.mocked(mcpService.removeServer).mockResolvedValue(true);
      vi.mocked(mcpService.listServers).mockResolvedValue({});

      const result = await useMcpStore
        .getState()
        .removeServer("/project/a", "server1");

      expect(result).toBe(true);
      expect(mcpService.listServers).toHaveBeenCalledWith("/project/a");
      expect(useMcpStore.getState().servers).toEqual({});
    });

    it("删除返回 false 时不应重新加载", async () => {
      useMcpStore.setState({ projectPath: "/project/a" });
      vi.mocked(mcpService.removeServer).mockResolvedValue(false);

      const result = await useMcpStore
        .getState()
        .removeServer("/project/a", "server1");

      expect(result).toBe(false);
      expect(mcpService.listServers).not.toHaveBeenCalled();
    });

    it("删除成功但路径不匹配时不应重新加载", async () => {
      useMcpStore.setState({ projectPath: "/project/b" });
      vi.mocked(mcpService.removeServer).mockResolvedValue(true);

      await useMcpStore.getState().removeServer("/project/a", "server1");

      expect(mcpService.listServers).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("应重置状态", () => {
      useMcpStore.setState({
        servers: mockServers,
        projectPath: "/project/a",
        error: "some error",
      });

      useMcpStore.getState().clear();

      const state = useMcpStore.getState();
      expect(state.servers).toEqual({});
      expect(state.projectPath).toBeNull();
      expect(state.error).toBeNull();
    });
  });
});
