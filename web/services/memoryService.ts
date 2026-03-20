/**
 * Memory 服务层 — 封装所有 Memory 相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Memory,
  MemoryQuery,
  MemoryQueryResult,
  MemoryStats,
  MemoryScope,
  StoreMemoryRequest,
  UpdateMemoryRequest,
} from "@/types";

export const memoryService = {
  /** 搜索 Memory（支持全文搜索 + 筛选） */
  async search(query: MemoryQuery): Promise<MemoryQueryResult> {
    return invoke<MemoryQueryResult>("search_memory", { query });
  },

  /** 存储新 Memory */
  async store(request: StoreMemoryRequest): Promise<Memory> {
    return invoke<Memory>("store_memory", { request });
  },

  /** 列出 Memory（按 scope/workspace/project 筛选） */
  async list(params?: {
    scope?: MemoryScope;
    workspaceName?: string;
    projectPath?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemoryQueryResult> {
    return invoke<MemoryQueryResult>("list_memories", {
      scope: params?.scope,
      workspaceName: params?.workspaceName,
      projectPath: params?.projectPath,
      limit: params?.limit,
      offset: params?.offset,
    });
  },

  /** 获取单个 Memory */
  async get(id: string): Promise<Memory | null> {
    return invoke<Memory | null>("get_memory", { id });
  },

  /** 更新 Memory */
  async update(id: string, request: UpdateMemoryRequest): Promise<boolean> {
    return invoke<boolean>("update_memory", { id, request });
  },

  /** 删除 Memory */
  async delete(id: string): Promise<boolean> {
    return invoke<boolean>("delete_memory", { id });
  },

  /** 获取统计信息 */
  async stats(params?: {
    workspaceName?: string;
    projectPath?: string;
  }): Promise<MemoryStats> {
    return invoke<MemoryStats>("get_memory_stats", {
      workspaceName: params?.workspaceName,
      projectPath: params?.projectPath,
    });
  },

  /** 准备会话上下文（project memories + 指定 memories） */
  async prepareSessionContext(
    projectPath: string,
    memoryIds: string[]
  ): Promise<string> {
    return invoke<string>("prepare_session_context", {
      projectPath,
      memoryIds,
    });
  },

  /** 格式化 Memory 用于注入 */
  async formatForInjection(memoryIds: string[]): Promise<string> {
    return invoke<string>("format_memory_for_injection", { memoryIds });
  },
};
