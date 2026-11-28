import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { sharedMcpService } from "./sharedMcpService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import type { SharedMcpServerConfig } from "@/types";

describe("sharedMcpService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("getConfig", () => {
    it("应该调用 get_shared_mcp_config 并返回配置", async () => {
      const config = { servers: {}, portRangeStart: 20000 };
      mockTauriInvoke({ get_shared_mcp_config: config });

      const result = await sharedMcpService.getConfig();

      expect(invoke).toHaveBeenCalledWith("get_shared_mcp_config");
      expect(result).toEqual(config);
    });
  });

  describe("getStatus", () => {
    it("应该调用 get_shared_mcp_status 并返回服务器状态列表", async () => {
      const status = [{ name: "fs", running: true }];
      mockTauriInvoke({ get_shared_mcp_status: status });

      const result = await sharedMcpService.getStatus();

      expect(invoke).toHaveBeenCalledWith("get_shared_mcp_status");
      expect(result).toEqual(status);
    });
  });

  describe("getHubStatus", () => {
    it("应该调用 get_mcp_hub_status 并返回 hub 状态", async () => {
      const status = { endpoint: "http://127.0.0.1:1/mcp-hub", servers: [{ name: "fs", running: true, routable: true, toolCount: 3 }] };
      mockTauriInvoke({ get_mcp_hub_status: status });

      const result = await sharedMcpService.getHubStatus();

      expect(invoke).toHaveBeenCalledWith("get_mcp_hub_status");
      expect(result).toEqual(status);
    });
  });

  describe("upsertServer", () => {
    it("应该调用 upsert_shared_mcp_server 并传递名称和配置", async () => {
      const config = { command: "npx", args: ["-y", "mcp-fs"] } as unknown as SharedMcpServerConfig;
      mockTauriInvoke({ upsert_shared_mcp_server: undefined });

      await sharedMcpService.upsertServer("fs", config);

      expect(invoke).toHaveBeenCalledWith("upsert_shared_mcp_server", {
        name: "fs",
        config,
      });
    });
  });

  describe("removeServer", () => {
    it("应该调用 remove_shared_mcp_server", async () => {
      mockTauriInvoke({ remove_shared_mcp_server: undefined });

      await sharedMcpService.removeServer("fs");

      expect(invoke).toHaveBeenCalledWith("remove_shared_mcp_server", {
        name: "fs",
      });
    });
  });

  describe("生命周期操作", () => {
    it("startServer 应该调用 start_shared_mcp_server", async () => {
      mockTauriInvoke({ start_shared_mcp_server: undefined });

      await sharedMcpService.startServer("fs");

      expect(invoke).toHaveBeenCalledWith("start_shared_mcp_server", {
        name: "fs",
      });
    });

    it("stopServer 应该调用 stop_shared_mcp_server", async () => {
      mockTauriInvoke({ stop_shared_mcp_server: undefined });

      await sharedMcpService.stopServer("fs");

      expect(invoke).toHaveBeenCalledWith("stop_shared_mcp_server", {
        name: "fs",
      });
    });

    it("restartServer 应该调用 restart_shared_mcp_server", async () => {
      mockTauriInvoke({ restart_shared_mcp_server: undefined });

      await sharedMcpService.restartServer("fs");

      expect(invoke).toHaveBeenCalledWith("restart_shared_mcp_server", {
        name: "fs",
      });
    });
  });

  describe("updateGlobalConfig", () => {
    it("应该调用 update_shared_mcp_global_config 并传递全部参数", async () => {
      mockTauriInvoke({ update_shared_mcp_global_config: undefined });

      await sharedMcpService.updateGlobalConfig(20000, 21000, 30, 3);

      expect(invoke).toHaveBeenCalledWith("update_shared_mcp_global_config", {
        portRangeStart: 20000,
        portRangeEnd: 21000,
        healthCheckIntervalSecs: 30,
        maxRestarts: 3,
      });
    });
  });

  describe("importFromClaude", () => {
    it("应该调用 import_shared_mcp_from_claude 并返回导入的服务器名称", async () => {
      mockTauriInvoke({ import_shared_mcp_from_claude: ["fs", "web"] });

      const result = await sharedMcpService.importFromClaude();

      expect(invoke).toHaveBeenCalledWith("import_shared_mcp_from_claude");
      expect(result).toEqual(["fs", "web"]);
    });
  });
});
