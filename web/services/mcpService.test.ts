import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { mcpService } from "./mcpService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import { resetTestDataCounter } from "@/test/utils/testData";
import type { McpServerConfig, OrchestratorStatus } from "@/types";

describe("mcpService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
    vi.mocked(getCurrentWebview().listen).mockReset();
    vi.mocked(getCurrentWebview().listen).mockResolvedValue(vi.fn(() => {}));
  });

  describe("listServers", () => {
    it("应该调用 list_mcp_servers 命令并返回服务器配置", async () => {
      const servers: Record<string, McpServerConfig> = {
        "my-server": {
          command: "node",
          args: ["server.js"],
          env: { PORT: "3000" },
        },
      };
      mockTauriInvoke({ list_mcp_servers: servers });

      const result = await mcpService.listServers({ projectPath: "/tmp/project" });

      expect(invoke).toHaveBeenCalledWith("list_mcp_servers", {
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(servers);
    });

    it("应该在无服务器时返回空对象", async () => {
      mockTauriInvoke({ list_mcp_servers: {} });

      const result = await mcpService.listServers({ projectPath: "/tmp/project" });

      expect(result).toEqual({});
    });

    it("工作空间层只传 workspaceName，不带 projectPath", async () => {
      mockTauriInvoke({ list_mcp_servers: {} });

      await mcpService.listServers({ workspaceName: "team" });

      expect(invoke).toHaveBeenCalledWith("list_mcp_servers", { workspaceName: "team" });
      expect(vi.mocked(invoke).mock.calls[0][1]).not.toHaveProperty("projectPath");
    });
  });

  describe("legacy servers", () => {
    it("lists legacy servers and imports them into the workspace layer", async () => {
      mockTauriInvoke({
        list_legacy_mcp_servers: { old: { command: "old", args: [], env: {} } },
        import_legacy_mcp_servers: ["old"],
      });

      await expect(mcpService.listLegacyServers("/tmp/project")).resolves.toHaveProperty("old");
      expect(invoke).toHaveBeenCalledWith("list_legacy_mcp_servers", { projectPath: "/tmp/project" });

      await expect(mcpService.importLegacyServers("/tmp/project", "team")).resolves.toEqual(["old"]);
      expect(invoke).toHaveBeenCalledWith("import_legacy_mcp_servers", {
        projectPath: "/tmp/project",
        workspaceName: "team",
        overwrite: false,
      });
    });
  });

  describe("getServer", () => {
    it("应该调用 get_mcp_server 命令并返回服务器配置", async () => {
      const server: McpServerConfig = {
        command: "python",
        args: ["server.py"],
        env: {},
      };
      mockTauriInvoke({ get_mcp_server: server });

      const result = await mcpService.getServer({ projectPath: "/tmp/project" }, "my-server");

      expect(invoke).toHaveBeenCalledWith("get_mcp_server", {
        projectPath: "/tmp/project",
        name: "my-server",
      });
      expect(result).toEqual(server);
    });

    it("应该在服务器不存在时返回 null", async () => {
      mockTauriInvoke({ get_mcp_server: null });

      const result = await mcpService.getServer({ projectPath: "/tmp/project" }, "non-existent");

      expect(result).toBeNull();
    });
  });

  describe("upsertServer", () => {
    it("应该调用 upsert_mcp_server 命令", async () => {
      mockTauriInvoke({ upsert_mcp_server: undefined });

      await mcpService.upsertServer(
        { projectPath: "/tmp/project" },
        "my-server",
        "node",
        ["server.js"],
        { PORT: "3000" },
      );

      expect(invoke).toHaveBeenCalledWith("upsert_mcp_server", {
        projectPath: "/tmp/project",
        name: "my-server",
        command: "node",
        args: ["server.js"],
        env: { PORT: "3000" },
      });
    });

    it("应该支持空参数和空环境变量", async () => {
      mockTauriInvoke({ upsert_mcp_server: undefined });

      await mcpService.upsertServer(
        { projectPath: "/tmp/project" },
        "simple-server",
        "python",
        [],
        {},
      );

      expect(invoke).toHaveBeenCalledWith("upsert_mcp_server", {
        projectPath: "/tmp/project",
        name: "simple-server",
        command: "python",
        args: [],
        env: {},
      });
    });
  });

  describe("removeServer", () => {
    it("应该调用 remove_mcp_server 命令并返回删除结果", async () => {
      mockTauriInvoke({ remove_mcp_server: true });

      const result = await mcpService.removeServer({ projectPath: "/tmp/project" }, "my-server");

      expect(invoke).toHaveBeenCalledWith("remove_mcp_server", {
        projectPath: "/tmp/project",
        name: "my-server",
      });
      expect(result).toBe(true);
    });

    it("应该在服务器不存在时返回 false", async () => {
      mockTauriInvoke({ remove_mcp_server: false });

      const result = await mcpService.removeServer({ projectPath: "/tmp/project" }, "non-existent");

      expect(result).toBe(false);
    });
  });

  describe("orchestrator status", () => {
    const status: OrchestratorStatus = {
      port: null,
      bind: { host: "127.0.0.1", mode: "auto", reason: "test" },
      lifecycle: "binding",
      attempt: 2,
      lastError: "port occupied",
      nextRetryAt: 123_456,
    };

    it("reads the complete lifecycle snapshot", async () => {
      mockTauriInvoke({ get_orchestrator_status: status });

      await expect(mcpService.getOrchestratorStatus()).resolves.toEqual(status);
      expect(invoke).toHaveBeenCalledWith("get_orchestrator_status");
    });

    it("maps orchestrator status events to payload callbacks", async () => {
      let eventHandler: ((event: { payload: OrchestratorStatus }) => void) | undefined;
      vi.mocked(getCurrentWebview().listen).mockImplementation(async (...args) => {
        eventHandler = args[1] as unknown as (event: { payload: OrchestratorStatus }) => void;
        return vi.fn(() => {});
      });
      const onStatus = vi.fn();

      await mcpService.onOrchestratorStatusChanged(onStatus);
      eventHandler?.({ payload: status });

      expect(getCurrentWebview().listen).toHaveBeenCalledWith(
        "orchestrator-status-changed",
        expect.any(Function),
      );
      expect(onStatus).toHaveBeenCalledWith(status);
    });
  });
});
