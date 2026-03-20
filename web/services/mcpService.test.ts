import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mcpService } from "./mcpService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import { resetTestDataCounter } from "@/test/utils/testData";
import type { McpServerConfig } from "@/types";

describe("mcpService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
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

      const result = await mcpService.listServers("/tmp/project");

      expect(invoke).toHaveBeenCalledWith("list_mcp_servers", {
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(servers);
    });

    it("应该在无服务器时返回空对象", async () => {
      mockTauriInvoke({ list_mcp_servers: {} });

      const result = await mcpService.listServers("/tmp/project");

      expect(result).toEqual({});
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

      const result = await mcpService.getServer("/tmp/project", "my-server");

      expect(invoke).toHaveBeenCalledWith("get_mcp_server", {
        projectPath: "/tmp/project",
        name: "my-server",
      });
      expect(result).toEqual(server);
    });

    it("应该在服务器不存在时返回 null", async () => {
      mockTauriInvoke({ get_mcp_server: null });

      const result = await mcpService.getServer("/tmp/project", "non-existent");

      expect(result).toBeNull();
    });
  });

  describe("upsertServer", () => {
    it("应该调用 upsert_mcp_server 命令", async () => {
      mockTauriInvoke({ upsert_mcp_server: undefined });

      await mcpService.upsertServer(
        "/tmp/project",
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
        "/tmp/project",
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

      const result = await mcpService.removeServer("/tmp/project", "my-server");

      expect(invoke).toHaveBeenCalledWith("remove_mcp_server", {
        projectPath: "/tmp/project",
        name: "my-server",
      });
      expect(result).toBe(true);
    });

    it("应该在服务器不存在时返回 false", async () => {
      mockTauriInvoke({ remove_mcp_server: false });

      const result = await mcpService.removeServer("/tmp/project", "non-existent");

      expect(result).toBe(false);
    });
  });
});
