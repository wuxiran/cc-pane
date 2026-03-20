/**
 * Memory 系统类型定义
 *
 * 注意：字段名与 Rust 端 serde 默认序列化格式保持一致（snake_case），
 * 因为 cc-memory crate 的 struct 没有 #[serde(rename_all = "camelCase")]。
 */

/** Memory 作用域 */
export type MemoryScope = "global" | "workspace" | "project" | "session";

/** Memory 类别 */
export type MemoryCategory =
  | "decision"
  | "lesson"
  | "preference"
  | "pattern"
  | "fact"
  | "plan"
  | string;

/** Memory 条目 */
export interface Memory {
  id: string;
  title: string;
  content: string;
  scope: MemoryScope;
  category: MemoryCategory;
  importance: number; // 1-5
  workspace_name: string | null;
  project_path: string | null;
  session_id: string | null;
  tags: string[];
  source: string; // "user" / "agent" / "mcp" / "hook"
  created_at: string; // RFC3339
  updated_at: string;
  accessed_at: string;
  access_count: number;
  // 云端预留
  user_id: string | null;
  sync_status: string; // "local_only" / "synced" / "pending_sync"
  sync_version: number;
  is_deleted: boolean;
}

/** Memory 查询参数 */
export interface MemoryQuery {
  search?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  min_importance?: number;
  workspace_name?: string;
  project_path?: string;
  session_id?: string;
  tags?: string[];
  from_date?: string; // RFC3339
  to_date?: string;
  sort_by?: string; // "relevance" / "created_at" / "updated_at" / "importance"
  limit?: number;
  offset?: number;
}

/** Memory 查询结果 */
export interface MemoryQueryResult {
  items: Memory[];
  total: number;
  has_more: boolean;
}

/** Memory 统计 */
export interface MemoryStats {
  total: number;
  by_scope: Record<string, number>;
  by_category: Record<string, number>;
}

/** 创建 Memory 的请求 */
export interface StoreMemoryRequest {
  title: string;
  content: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  importance?: number;
  workspace_name?: string;
  project_path?: string;
  session_id?: string;
  tags?: string[];
  source?: string;
}

/** 更新 Memory 的请求 */
export interface UpdateMemoryRequest {
  title?: string;
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  tags?: string[];
}
