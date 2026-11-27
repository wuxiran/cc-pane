/**
 * GitHub（经本机 gh CLI）类型。字段与 Rust `cc_panes_core::services::github_cli` 的 camelCase 序列化一致。
 */
import type { TodoItem } from "./todo";

/** gh 是否已安装、已登录 */
export interface GhAvailability {
  installed: boolean;
  authenticated: boolean;
  account?: string;
  host?: string;
}

/** Issue 列表项（带已导入标记） */
export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  author?: string;
  updatedAt?: string;
  /** 已导入为 Todo 时对应的任务 id */
  importedTodoId?: string;
}

/** 单个 Issue 的导入结果 */
export interface GithubIssueImportResult {
  number: number;
  todo?: TodoItem;
  alreadyImported: boolean;
  error?: string;
}
