import { describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { memoryService } from "./memoryService";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  createTestMemory,
  resetTestDataCounter,
} from "@/test/utils/testData";
import type {
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
  StoreMemoryRequest,
  UpdateMemoryRequest,
} from "@/types";

// ---- 测试数据工厂 ----

function createTestQueryResult(overrides?: Partial<MemoryQueryResult>): MemoryQueryResult {
  return {
    items: [createTestMemory()],
    total: 1,
    has_more: false,
    ...overrides,
  };
}

function createTestStats(overrides?: Partial<MemoryStats>): MemoryStats {
  return {
    total: 10,
    by_scope: { global: 5, project: 5 },
    by_category: { fact: 3, decision: 7 },
    ...overrides,
  };
}

describe("memoryService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    resetTestDataCounter();
  });

  describe("search", () => {
    it("应该调用 search_memory 命令并返回查询结果", async () => {
      const query: MemoryQuery = { search: "test", limit: 10 };
      const queryResult = createTestQueryResult();
      mockTauriInvoke({ search_memory: queryResult });

      const result = await memoryService.search(query);

      expect(invoke).toHaveBeenCalledWith("search_memory", { query });
      expect(result).toEqual(queryResult);
    });
  });

  describe("store", () => {
    it("应该调用 store_memory 命令并返回新 Memory", async () => {
      const request: StoreMemoryRequest = {
        title: "Test Memory",
        content: "Some content",
        scope: "global",
        category: "fact",
      };
      const memory = createTestMemory({ title: "Test Memory" });
      mockTauriInvoke({ store_memory: memory });

      const result = await memoryService.store(request);

      expect(invoke).toHaveBeenCalledWith("store_memory", { request });
      expect(result).toEqual(memory);
    });
  });

  describe("list", () => {
    it("应该调用 list_memories 命令并传递筛选参数", async () => {
      const queryResult = createTestQueryResult();
      mockTauriInvoke({ list_memories: queryResult });

      const result = await memoryService.list({
        scope: "project",
        workspaceName: "ws-1",
        projectPath: "/tmp/project",
        limit: 20,
        offset: 0,
      });

      expect(invoke).toHaveBeenCalledWith("list_memories", {
        scope: "project",
        workspaceName: "ws-1",
        projectPath: "/tmp/project",
        limit: 20,
        offset: 0,
      });
      expect(result).toEqual(queryResult);
    });

    it("应该在无参数时传递 undefined 值", async () => {
      const queryResult = createTestQueryResult();
      mockTauriInvoke({ list_memories: queryResult });

      const result = await memoryService.list();

      expect(invoke).toHaveBeenCalledWith("list_memories", {
        scope: undefined,
        workspaceName: undefined,
        projectPath: undefined,
        limit: undefined,
        offset: undefined,
      });
      expect(result).toEqual(queryResult);
    });
  });

  describe("get", () => {
    it("应该调用 get_memory 命令并返回 Memory", async () => {
      const memory = createTestMemory();
      mockTauriInvoke({ get_memory: memory });

      const result = await memoryService.get(memory.id);

      expect(invoke).toHaveBeenCalledWith("get_memory", { id: memory.id });
      expect(result).toEqual(memory);
    });

    it("应该在 Memory 不存在时返回 null", async () => {
      mockTauriInvoke({ get_memory: null });

      const result = await memoryService.get("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("update", () => {
    it("应该调用 update_memory 命令并返回更新结果", async () => {
      const request: UpdateMemoryRequest = {
        title: "Updated Title",
        importance: 5,
      };
      mockTauriInvoke({ update_memory: true });

      const result = await memoryService.update("mem-1", request);

      expect(invoke).toHaveBeenCalledWith("update_memory", {
        id: "mem-1",
        request,
      });
      expect(result).toBe(true);
    });
  });

  describe("delete", () => {
    it("应该调用 delete_memory 命令并返回删除结果", async () => {
      mockTauriInvoke({ delete_memory: true });

      const result = await memoryService.delete("mem-1");

      expect(invoke).toHaveBeenCalledWith("delete_memory", { id: "mem-1" });
      expect(result).toBe(true);
    });
  });

  describe("stats", () => {
    it("应该调用 get_memory_stats 命令并传递筛选参数", async () => {
      const stats = createTestStats();
      mockTauriInvoke({ get_memory_stats: stats });

      const result = await memoryService.stats({
        workspaceName: "ws-1",
        projectPath: "/tmp/project",
      });

      expect(invoke).toHaveBeenCalledWith("get_memory_stats", {
        workspaceName: "ws-1",
        projectPath: "/tmp/project",
      });
      expect(result).toEqual(stats);
    });

    it("应该在无参数时传递 undefined 值", async () => {
      const stats = createTestStats();
      mockTauriInvoke({ get_memory_stats: stats });

      const result = await memoryService.stats();

      expect(invoke).toHaveBeenCalledWith("get_memory_stats", {
        workspaceName: undefined,
        projectPath: undefined,
      });
      expect(result).toEqual(stats);
    });
  });

  describe("prepareSessionContext", () => {
    it("应该调用 prepare_session_context 命令并返回上下文字符串", async () => {
      mockTauriInvoke({ prepare_session_context: "context content" });

      const result = await memoryService.prepareSessionContext(
        "/tmp/project",
        ["mem-1", "mem-2"],
      );

      expect(invoke).toHaveBeenCalledWith("prepare_session_context", {
        projectPath: "/tmp/project",
        memoryIds: ["mem-1", "mem-2"],
      });
      expect(result).toBe("context content");
    });
  });

  describe("formatForInjection", () => {
    it("应该调用 format_memory_for_injection 命令并返回格式化字符串", async () => {
      mockTauriInvoke({ format_memory_for_injection: "formatted content" });

      const result = await memoryService.formatForInjection(["mem-1", "mem-2"]);

      expect(invoke).toHaveBeenCalledWith("format_memory_for_injection", {
        memoryIds: ["mem-1", "mem-2"],
      });
      expect(result).toBe("formatted content");
    });
  });
});
