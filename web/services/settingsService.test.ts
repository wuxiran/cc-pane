import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { settingsService } from "./settingsService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestSettings,
  resetTestDataCounter,
} from "@/test/utils/testData";
import type { DataDirInfo, UninstallCleanupReport } from "@/types";

describe("settingsService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  describe("getSettings", () => {
    it("应该调用 get_settings 命令并返回设置", async () => {
      const settings = createTestSettings();
      mockTauriInvoke({ get_settings: settings });

      const result = await settingsService.getSettings();

      expect(invoke).toHaveBeenCalledWith("get_settings");
      expect(result).toEqual(settings);
    });
  });

  describe("updateSettings", () => {
    it("应该调用 update_settings 命令", async () => {
      const settings = createTestSettings({ theme: { mode: "light" } });
      mockTauriInvoke({ update_settings: undefined });

      await settingsService.updateSettings(settings);

      expect(invoke).toHaveBeenCalledWith("update_settings", { settings });
    });
  });

  describe("testProxy", () => {
    it("应该调用 test_proxy 命令并返回测试结果", async () => {
      mockTauriInvoke({ test_proxy: true });

      const result = await settingsService.testProxy();

      expect(invoke).toHaveBeenCalledWith("test_proxy");
      expect(result).toBe(true);
    });

    it("应该在代理不可用时返回 false", async () => {
      mockTauriInvoke({ test_proxy: false });

      const result = await settingsService.testProxy();

      expect(result).toBe(false);
    });
  });

  describe("testCliLauncher", () => {
    it("应该调用 test_cli_launcher 命令并返回输出", async () => {
      mockTauriInvoke({ test_cli_launcher: "2.1.191 (Claude Code)" });

      const result = await settingsService.testCliLauncher("reclaude", ["--version"]);

      expect(invoke).toHaveBeenCalledWith("test_cli_launcher", {
        command: "reclaude",
        versionArgs: ["--version"],
      });
      expect(result).toBe("2.1.191 (Claude Code)");
    });
  });

  describe("getDataDirInfo", () => {
    it("应该调用 get_data_dir_info 命令并返回目录信息", async () => {
      const info: DataDirInfo = {
        currentPath: "/home/user/.cc-panes",
        defaultPath: "/home/user/.cc-panes",
        isDefault: true,
        sizeBytes: 1048576,
      };
      mockTauriInvoke({ get_data_dir_info: info });

      const result = await settingsService.getDataDirInfo();

      expect(invoke).toHaveBeenCalledWith("get_data_dir_info");
      expect(result).toEqual(info);
    });
  });

  describe("migrateDataDir", () => {
    it("应该调用 migrate_data_dir 命令", async () => {
      mockTauriInvoke({ migrate_data_dir: undefined });

      await settingsService.migrateDataDir("/new/data/dir");

      expect(invoke).toHaveBeenCalledWith("migrate_data_dir", {
        targetDir: "/new/data/dir",
      });
    });
  });

  describe("cleanupBeforeUninstall", () => {
    it("应该调用 cleanup_before_uninstall 并返回清理报告", async () => {
      const report: UninstallCleanupReport = {
        cleaned: ["~/.claude/commands/ccpanes"],
        skipped: [],
        failed: [],
      };
      mockTauriInvoke({ cleanup_before_uninstall: report });

      const result = await settingsService.cleanupBeforeUninstall();

      expect(invoke).toHaveBeenCalledWith("cleanup_before_uninstall");
      expect(result).toEqual(report);
    });
  });
});
