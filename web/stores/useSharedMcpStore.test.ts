import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  SharedMcpServerInfo,
  SharedMcpServerConfig,
  SharedMcpConfig,
} from "@/types";

// Mock 服务层（store 通过 @/services barrel 引入 sharedMcpService）
vi.mock("@/services", () => ({
  sharedMcpService: {
    getStatus: vi.fn(),
    getConfig: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    upsertServer: vi.fn(),
    removeServer: vi.fn(),
    importFromClaude: vi.fn(),
  },
}));

import { sharedMcpService } from "@/services";
import { useSharedMcpStore } from "./useSharedMcpStore";

const mockSvc = sharedMcpService as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

function createServerConfig(
  overrides: Partial<SharedMcpServerConfig> = {},
): SharedMcpServerConfig {
  return {
    command: "node",
    args: [],
    env: {},
    shared: true,
    port: 9000,
    bridgeMode: "mcp-proxy",
    ...overrides,
  };
}

function createServerInfo(
  overrides: Partial<SharedMcpServerInfo> = {},
): SharedMcpServerInfo {
  return {
    name: "srv",
    config: createServerConfig(),
    status: "Running",
    pid: 123,
    url: "http://localhost:9000",
    restartCount: 0,
    ...overrides,
  };
}

function createConfig(): SharedMcpConfig {
  return {
    servers: {},
    portRangeStart: 9000,
    portRangeEnd: 9100,
    healthCheckIntervalSecs: 30,
    maxRestarts: 3,
  };
}

describe("useSharedMcpStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认成功解析，避免刷新链抛错
    mockSvc.getStatus.mockResolvedValue([]);
    mockSvc.getConfig.mockResolvedValue(createConfig());
    mockSvc.startServer.mockResolvedValue(undefined);
    mockSvc.stopServer.mockResolvedValue(undefined);
    mockSvc.restartServer.mockResolvedValue(undefined);
    mockSvc.upsertServer.mockResolvedValue(undefined);
    mockSvc.removeServer.mockResolvedValue(undefined);
    mockSvc.importFromClaude.mockResolvedValue([]);
    useSharedMcpStore.setState({
      servers: [],
      config: null,
      loading: false,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useSharedMcpStore.getState();
      expect(state.servers).toEqual([]);
      expect(state.config).toBeNull();
      expect(state.loading).toBe(false);
    });
  });

  describe("fetchStatus", () => {
    it("应该写入服务器列表", async () => {
      const servers = [createServerInfo({ name: "a" })];
      mockSvc.getStatus.mockResolvedValue(servers);

      await useSharedMcpStore.getState().fetchStatus();

      expect(useSharedMcpStore.getState().servers).toEqual(servers);
    });

    it("失败时应静默保留原有列表", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockSvc.getStatus.mockRejectedValue(new Error("boom"));

      await useSharedMcpStore.getState().fetchStatus();

      expect(useSharedMcpStore.getState().servers).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("fetchConfig", () => {
    it("应该写入配置", async () => {
      const config = createConfig();
      mockSvc.getConfig.mockResolvedValue(config);

      await useSharedMcpStore.getState().fetchConfig();

      expect(useSharedMcpStore.getState().config).toEqual(config);
    });

    it("失败时应静默保留原有配置", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockSvc.getConfig.mockRejectedValue(new Error("boom"));

      await useSharedMcpStore.getState().fetchConfig();

      expect(useSharedMcpStore.getState().config).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("startServer", () => {
    it("应该启动并刷新状态", async () => {
      await useSharedMcpStore.getState().startServer("a");

      expect(mockSvc.startServer).toHaveBeenCalledWith("a");
      expect(mockSvc.getStatus).toHaveBeenCalled();
    });
  });

  describe("stopServer", () => {
    it("应该停止并刷新状态", async () => {
      await useSharedMcpStore.getState().stopServer("a");

      expect(mockSvc.stopServer).toHaveBeenCalledWith("a");
      expect(mockSvc.getStatus).toHaveBeenCalled();
    });
  });

  describe("restartServer", () => {
    it("应该重启并刷新状态", async () => {
      await useSharedMcpStore.getState().restartServer("a");

      expect(mockSvc.restartServer).toHaveBeenCalledWith("a");
      expect(mockSvc.getStatus).toHaveBeenCalled();
    });
  });

  describe("upsertServer", () => {
    it("应该保存并刷新状态与配置", async () => {
      const config = createServerConfig();

      await useSharedMcpStore.getState().upsertServer("a", config);

      expect(mockSvc.upsertServer).toHaveBeenCalledWith("a", config);
      expect(mockSvc.getStatus).toHaveBeenCalled();
      expect(mockSvc.getConfig).toHaveBeenCalled();
    });
  });

  describe("toggleShared", () => {
    it("shared=true 时应更新配置并启动服务", async () => {
      const server = createServerInfo({
        name: "a",
        config: createServerConfig({ shared: false }),
      });
      useSharedMcpStore.setState({ servers: [server] });

      await useSharedMcpStore.getState().toggleShared("a", true);

      expect(mockSvc.upsertServer).toHaveBeenCalledWith("a", {
        ...server.config,
        shared: true,
      });
      expect(mockSvc.startServer).toHaveBeenCalledWith("a");
      expect(mockSvc.stopServer).not.toHaveBeenCalled();
      expect(mockSvc.getStatus).toHaveBeenCalled();
      expect(mockSvc.getConfig).toHaveBeenCalled();
    });

    it("shared=false 时应更新配置并停止服务", async () => {
      const server = createServerInfo({
        name: "a",
        config: createServerConfig({ shared: true }),
      });
      useSharedMcpStore.setState({ servers: [server] });

      await useSharedMcpStore.getState().toggleShared("a", false);

      expect(mockSvc.upsertServer).toHaveBeenCalledWith("a", {
        ...server.config,
        shared: false,
      });
      expect(mockSvc.stopServer).toHaveBeenCalledWith("a");
      expect(mockSvc.startServer).not.toHaveBeenCalled();
    });

    it("服务器不存在时应直接返回", async () => {
      useSharedMcpStore.setState({ servers: [] });

      await useSharedMcpStore.getState().toggleShared("missing", true);

      expect(mockSvc.upsertServer).not.toHaveBeenCalled();
      expect(mockSvc.startServer).not.toHaveBeenCalled();
    });
  });

  describe("removeServer", () => {
    it("应该删除并刷新状态与配置", async () => {
      await useSharedMcpStore.getState().removeServer("a");

      expect(mockSvc.removeServer).toHaveBeenCalledWith("a");
      expect(mockSvc.getStatus).toHaveBeenCalled();
      expect(mockSvc.getConfig).toHaveBeenCalled();
    });
  });

  describe("importFromClaude", () => {
    it("应该导入并刷新状态与配置且返回导入结果", async () => {
      mockSvc.importFromClaude.mockResolvedValue(["a", "b"]);

      const result = await useSharedMcpStore.getState().importFromClaude();

      expect(result).toEqual(["a", "b"]);
      expect(mockSvc.getStatus).toHaveBeenCalled();
      expect(mockSvc.getConfig).toHaveBeenCalled();
    });
  });
});
