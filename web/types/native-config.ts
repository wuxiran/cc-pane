// 分层原生 CLI 配置（镜像后端 `services::native_config`）。
// 合并顺序：CLI 自己的配置 ← 中转站片段 ← 运行配置片段 ← CC-Panes 显式字段。

/** CLI id（`codex` / `claude`）→ 片段原文（Codex 为 TOML、Claude 为 JSON）。 */
export type NativeOverrides = Record<string, string>;

/** 支持原生配置覆盖的 CLI。 */
export const NATIVE_OVERRIDE_TOOLS = ["codex", "claude"] as const;
export type NativeOverrideTool = (typeof NATIVE_OVERRIDE_TOOLS)[number];

export function isNativeOverrideTool(tool: string | null | undefined): tool is NativeOverrideTool {
  return tool === "codex" || tool === "claude";
}

/** 生效叶子来自哪一层：中转站 / 运行配置 / CC-Panes 显式字段。 */
export type NativeConfigSource = "provider" | "profile" | "managed";

export type NativeConfigIssueCode =
  | "parseError"
  | "notAnObject"
  | "forbiddenKey"
  | "secretKey"
  | "unsupportedTool"
  | "tooLarge";

export interface NativeConfigIssue {
  tool: string;
  layer?: NativeConfigSource | null;
  key?: string | null;
  code: NativeConfigIssueCode;
  /** 后端英文说明（只含键名与位置，不回显片段内容）。 */
  message: string;
}

export interface NativeConfigEntry {
  key: string;
  /** 字面量：Codex 为 TOML、Claude 为 JSON。 */
  value: string;
  source: NativeConfigSource;
}

export interface NativeConfigRuntime {
  runtime: "local" | "wsl" | "ssh" | string;
  applied: boolean;
  /** 不生效原因代码。 */
  note?: string | null;
}

export interface NativeConfigPreview {
  cliTool: string;
  supported: boolean;
  entries: NativeConfigEntry[];
  runtimes: NativeConfigRuntime[];
  issues: NativeConfigIssue[];
  providerName?: string | null;
  modelId?: string | null;
}

/** 导入时建议给运行配置的内容。不含密钥。 */
export interface ImportedProfileHints {
  nativeTool?: string | null;
  nativeOverride?: string | null;
  yoloMode?: boolean;
  modelId?: string | null;
  /** 来源里有、但没有导入的顶层键。 */
  droppedKeys?: string[];
}
