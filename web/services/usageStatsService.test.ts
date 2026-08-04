import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { usageStatsService } from "./usageStatsService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("usageStatsService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  describe("queryUsage", () => {
    it("应该调用 query_usage_stats 并传递天数与过滤器", async () => {
      const usage = { days: [], totals: {} };
      mockTauriInvoke({ query_usage_stats: usage });

      const result = await usageStatsService.queryUsage(7, "ws-1");

      expect(invoke).toHaveBeenCalledWith("query_usage_stats", {
        rangeDays: 7,
        workspaceFilter: "ws-1",
      });
      expect(result).toEqual(usage);
    });

    it("应该将空过滤器归一化为 null", async () => {
      mockTauriInvoke({ query_usage_stats: {} });

      await usageStatsService.queryUsage(30, "");

      expect(invoke).toHaveBeenCalledWith("query_usage_stats", {
        rangeDays: 30,
        workspaceFilter: null,
      });
    });

    it("应该在未传过滤器时使用 null", async () => {
      mockTauriInvoke({ query_usage_stats: {} });

      await usageStatsService.queryUsage(30);

      expect(invoke).toHaveBeenCalledWith("query_usage_stats", {
        rangeDays: 30,
        workspaceFilter: null,
      });
    });
  });

  describe("queryContextUsage", () => {
    it("calls the context usage command with the active PTY id", async () => {
      const snapshot = { status: "waiting", observedAt: 1 };
      mockTauriInvoke({ query_context_usage: snapshot });

      await expect(usageStatsService.queryContextUsage("pty-1")).resolves.toEqual(snapshot);
      expect(invoke).toHaveBeenCalledWith("query_context_usage", {
        ptySessionId: "pty-1",
      });
    });
  });

  describe("refreshUsage", () => {
    it("应该调用 refresh_usage_stats", async () => {
      mockTauriInvoke({ refresh_usage_stats: undefined });

      await usageStatsService.refreshUsage();

      expect(invoke).toHaveBeenCalledWith("refresh_usage_stats");
    });
  });

  describe("recordInputChars", () => {
    it("应该调用 record_terminal_input 并传递字符数", async () => {
      mockTauriInvoke({ record_terminal_input: undefined });

      await usageStatsService.recordInputChars("s-1", 42);

      expect(invoke).toHaveBeenCalledWith("record_terminal_input", {
        sessionId: "s-1",
        charCount: 42,
      });
    });

    it("应该在字符数为 0 时跳过调用", async () => {
      await usageStatsService.recordInputChars("s-1", 0);

      expect(invoke).not.toHaveBeenCalled();
    });

    it("应该在字符数为负时跳过调用", async () => {
      await usageStatsService.recordInputChars("s-1", -5);

      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
