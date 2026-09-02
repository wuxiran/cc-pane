import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMcpStore } from "./useMcpStore";
import { mcpService } from "@/services";
import type { McpServerConfig } from "@/types";

vi.mock("@/services", () => ({
  mcpService: {
    listServers: vi.fn(),
    upsertServer: vi.fn(),
    removeServer: vi.fn(),
    listLegacyServers: vi.fn(),
    importLegacyServers: vi.fn(),
  },
}));

const mockServers: Record<string, McpServerConfig> = {
  server1: { command: "node", args: ["server.js"], env: {} },
  server2: { command: "python", args: ["main.py"], env: { KEY: "val" } },
};

const projectA = { projectPath: "/project/a" } as const;
const projectB = { projectPath: "/project/b" } as const;
const teamWs = { workspaceName: "team" } as const;

describe("useMcpStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMcpStore.setState({
      servers: {},
      targetKey: null,
      legacyServers: {},
      loading: false,
      error: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useMcpStore.getState();
      expect(state.servers).toEqual({});
      expect(state.targetKey).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe("loadServers", () => {
    it("成功时应加载服务器列表并记录目标层", async () => {
      vi.mocked(mcpService.listServers).mockResolvedValue(mockServers);

      await useMcpStore.getState().loadServers(projectA);

      const state = useMcpStore.getState();
      expect(state.servers).toEqual(mockServers);
      expect(state.targetKey).toBe("project:/project/a");
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("工作空间层的 targetKey 与项目层区分", async () => {
      vi.mocked(mcpService.listServers).mockResolvedValue({});
      await useMcpStore.getState().loadServers(teamWs);
      expect(useMcpStore.getState().targetKey).toBe("workspace:team");
      expect(mcpService.listServers).toHaveBeenCalledWith(teamWs);
    });

    it("加载期间 loading 应为 true", async () => {
      vi.mocked(mcpService.listServers).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({}), 10))
      );

      const loadPromise = useMcpStore.getState().loadServers(projectA);
      expect(useMcpStore.getState().loading).toBe(true);

      await loadPromise;
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it("失败时应设置 error", async () => {
      vi.mocked(mcpService.listServers).mockRejectedValue(new Error("load failed"));

      await useMcpStore.getState().loadServers(projectA);

      const state = useMcpStore.getState();
      expect(state.error).toContain("load failed");
      expect(state.loading).toBe(false);
    });
  });

  describe("upsertServer", () => {
    it("目标层匹配时应重新加载服务器列表", async () => {
      useMcpStore.setState({ targetKey: "project:/project/a" });
      vi.mocked(mcpService.upsertServer).mockResolvedValue();
      vi.mocked(mcpService.listServers).mockResolvedValue(mockServers);

      await useMcpStore.getState().upsertServer(projectA, "server1", "node", ["server.js"], {});

      expect(mcpService.upsertServer).toHaveBeenCalledWith(projectA, "server1", "node", ["server.js"], {});
      expect(mcpService.listServers).toHaveBeenCalledWith(projectA);
      expect(useMcpStore.getState().servers).toEqual(mockServers);
    });

    it("目标层不匹配时不应重新加载", async () => {
      useMcpStore.setState({ targetKey: "project:/project/b" });
      vi.mocked(mcpService.upsertServer).mockResolvedValue();

      await useMcpStore.getState().upsertServer(projectA, "server1", "node", [], {});

      expect(mcpService.upsertServer).toHaveBeenCalled();
      expect(mcpService.listServers).not.toHaveBeenCalled();
    });
  });

  describe("removeServer", () => {
    it("删除成功且目标层匹配时应重新加载", async () => {
      useMcpStore.setState({ targetKey: "project:/project/a" });
      vi.mocked(mcpService.removeServer).mockResolvedValue(true);
      vi.mocked(mcpService.listServers).mockResolvedValue({});

      const result = await useMcpStore.getState().removeServer(projectA, "server1");

      expect(result).toBe(true);
      expect(mcpService.listServers).toHaveBeenCalledWith(projectA);
      expect(useMcpStore.getState().servers).toEqual({});
    });

    it("删除返回 false 时不应重新加载", async () => {
      useMcpStore.setState({ targetKey: "project:/project/a" });
      vi.mocked(mcpService.removeServer).mockResolvedValue(false);

      const result = await useMcpStore.getState().removeServer(projectA, "server1");

      expect(result).toBe(false);
      expect(mcpService.listServers).not.toHaveBeenCalled();
    });

    it("删除成功但目标层不匹配时不应重新加载", async () => {
      useMcpStore.setState({ targetKey: "project:/project/b" });
      vi.mocked(mcpService.removeServer).mockResolvedValue(true);

      await useMcpStore.getState().removeServer(projectA, "server1");

      expect(mcpService.listServers).not.toHaveBeenCalled();
    });
  });

  describe("legacy import", () => {
    it("loadLegacyServers 失败时降级为空，不抛错", async () => {
      vi.mocked(mcpService.listLegacyServers).mockRejectedValue(new Error("nope"));
      await useMcpStore.getState().loadLegacyServers("/project/a");
      expect(useMcpStore.getState().legacyServers).toEqual({});
    });

    it("导入到工作空间后，若当前正看该工作空间层则刷新", async () => {
      useMcpStore.setState({ targetKey: "workspace:team" });
      vi.mocked(mcpService.importLegacyServers).mockResolvedValue(["old"]);
      vi.mocked(mcpService.listServers).mockResolvedValue(mockServers);

      const imported = await useMcpStore.getState().importLegacyServers("/project/a", "team");

      expect(imported).toEqual(["old"]);
      expect(mcpService.listServers).toHaveBeenCalledWith(teamWs);
      expect(useMcpStore.getState().servers).toEqual(mockServers);
    });

    it("导入到项目覆盖层时按项目层刷新；无导入则不刷新", async () => {
      useMcpStore.setState({ targetKey: "project:/project/b" });
      vi.mocked(mcpService.importLegacyServers).mockResolvedValue([]);
      await useMcpStore.getState().importLegacyServers("/project/b");
      expect(mcpService.listServers).not.toHaveBeenCalled();

      vi.mocked(mcpService.importLegacyServers).mockResolvedValue(["x"]);
      vi.mocked(mcpService.listServers).mockResolvedValue({});
      await useMcpStore.getState().importLegacyServers("/project/b");
      expect(mcpService.listServers).toHaveBeenCalledWith(projectB);
    });
  });

  describe("clear", () => {
    it("应重置状态", () => {
      useMcpStore.setState({
        servers: mockServers,
        targetKey: "project:/project/a",
        error: "some error",
      });

      useMcpStore.getState().clear();

      const state = useMcpStore.getState();
      expect(state.servers).toEqual({});
      expect(state.targetKey).toBeNull();
      expect(state.error).toBeNull();
    });
  });
});
