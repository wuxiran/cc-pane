// 灵动岛：设置（镜像 cc-panes-core IslandSettings）+ 主窗口 → 岛窗口的事件桥载荷。
import type { RateLimitWindow } from "./rateLimit";

export type IslandPosition = "top" | "left" | "right";
export type IslandDisplay = "mouse" | "primary";

export interface IslandSettings {
  enabled: boolean;
  position: IslandPosition;
  display: IslandDisplay;
  popOnFinish: boolean;
  showQuota: boolean;
  collapseInFullscreen: boolean;
  hideWhenMainFocused: boolean;
}

/** 与 Rust `IslandSettings::default()` 同口径：首个版本默认关闭。 */
export const DEFAULT_ISLAND_SETTINGS: IslandSettings = {
  enabled: false,
  position: "top",
  display: "mouse",
  popOnFinish: true,
  showQuota: true,
  collapseInFullscreen: true,
  hideWhenMainFocused: false,
};

/** 后端环境探测（全屏 / 主窗口前台）。 */
export interface IslandEnv {
  fullscreen: boolean;
  mainFocused: boolean;
}

export type IslandSessionState = "needs" | "running" | "done";
export type IslandSessionKind = "terminal" | "chat";

export interface IslandApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

/** Agent Chat（ACP）待批请求：选项原样来自 agent，岛上不造选项。 */
export interface IslandApproval {
  requestKey: string;
  title: string | null;
  detail: string | null;
  options: IslandApprovalOption[];
  responding: boolean;
  error: string | null;
  /** 同一会话排在后面的待批数。 */
  queued: number;
}

export interface IslandSession {
  /** terminal = PTY sessionId；chat = chatId。 */
  id: string;
  kind: IslandSessionKind;
  name: string;
  /** CLI 显示名（Claude / Codex / …）。 */
  cli: string;
  state: IslandSessionState;
  /** 当前在做的事（工具摘要 / 完成摘要）；没有就 null。 */
  activity: string | null;
  /** running：开始时间；needs：开始等待时间；done：完成时间（epoch ms）。 */
  since: number;
  approval: IslandApproval | null;
}

export interface IslandQuota {
  /** 额度来源 CLI 显示名，目前只有 Codex 在本地日志里写额度。 */
  provider: string;
  windows: RateLimitWindow[];
}

export interface IslandSnapshot {
  sessions: IslandSession[];
  quota: IslandQuota | null;
}

export const EMPTY_ISLAND_SNAPSHOT: IslandSnapshot = { sessions: [], quota: null };

export interface IslandNavigateTarget {
  kind: IslandSessionKind;
  id: string;
}

export interface IslandPermissionResponse {
  chatId: string;
  requestKey: string;
  optionId: string | null;
}

export const ISLAND_WINDOW_LABEL = "island";
/** 主窗口 → 岛：会话快照。 */
export const ISLAND_STATE_EVENT = "island:state";
/** 岛 → 主窗口：请求立即推一次快照（岛刚加载）。 */
export const ISLAND_REQUEST_STATE_EVENT = "island:request-state";
/** 岛 → 主窗口：回应 ACP 审批（走主窗口 store 的既有 respond 路径）。 */
export const ISLAND_RESPOND_PERMISSION_EVENT = "island:respond-permission";
/** 后端 → 主窗口：定位会话（island_activate_session 已先把主窗口唤到前台）。 */
export const ISLAND_NAVIGATE_EVENT = "island:navigate";
/** 后端 → 岛。 */
export const ISLAND_ENV_EVENT = "island:env";
export const ISLAND_SETTINGS_EVENT = "island:settings";
