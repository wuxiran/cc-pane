// 任务球（ccchan 的另一种外观）的纯数据模型：列表排序、外圈分段、中心计数、
// 窗口内布局。纯函数，便于测试。
//
// 尺寸常量必须与 src-tauri/src/services/ccchan_window.rs 的 ORB_* 同步。
import { INPUT_ACTIVE_WINDOW_MS } from "@/stores/useTerminalInputActivityStore";
import { PET_STATUS_COLOR, type PetStatus, type SessionPetEntry } from "./petStatus";
import type { CCChanOrbSort, SessionDirectoryEntry } from "./types";

/**
 * 交互时序（毫秒）。暂定值，集中在这里调整：
 * - openDelayMs：悬停球多久展开列表
 * - dwellSwitchMs：悬停某行多久自动切到该会话
 * - closeDelayMs：离开球和列表多久收起（跨过间隙不会误关）
 */
export const ORB_TIMINGS = {
  openDelayMs: 200,
  dwellSwitchMs: 650,
  closeDelayMs: 280,
} as const;

export const ORB_SIZE = 56;
export const ORB_PADDING = 14;
export const ORB_WINDOW = ORB_SIZE + ORB_PADDING * 2;
export const ORB_PANEL_WIDTH = 320;
export const ORB_PANEL_GAP = 4;
export const ORB_PANEL_MAX_HEIGHT = 480;
/** 外圈段间缝隙（度）。 */
export const ORB_RING_GAP_DEG = 7;
/** 列表里输入时间标蓝的窗口：沿用轴1「人在手边」的判定窗口。 */
export const ORB_FRESH_INPUT_MS = INPUT_ACTIVE_WINDOW_MS;

/** 面板各部分高度（逻辑像素）：用于向后端申请展开尺寸。 */
export const ORB_PANEL_METRICS = {
  header: 72,
  current: 22,
  section: 24,
  row: 44,
  listPadding: 12,
  empty: 44,
} as const;

export interface OrbEntry extends SessionPetEntry {
  /** 最后一次真实键盘输入；从未输入 = null。 */
  lastInputAt: number | null;
  /** 主窗口当前激活面板里的会话。 */
  active: boolean;
}

/** 状态权重：越小越需要我（等你回复 › 出错 › 完成未看 › 运行中 › 空闲）。 */
export const ORB_ATTENTION_WEIGHT: Record<PetStatus, number> = {
  needsInput: 0,
  blocked: 1,
  ready: 2,
  running: 3,
  idle: 4,
};

export function buildOrbEntries(
  entries: readonly SessionPetEntry[],
  directory: ReadonlyMap<string, SessionDirectoryEntry>,
): OrbEntry[] {
  return entries.map((entry) => {
    const info = directory.get(entry.sessionId);
    const lastInputAt = typeof info?.lastInputAt === "number" ? info.lastInputAt : null;
    return { ...entry, lastInputAt, active: info?.active === true };
  });
}

const inputTime = (entry: OrbEntry) => entry.lastInputAt ?? Number.NEGATIVE_INFINITY;

function byRecent(a: OrbEntry, b: OrbEntry): number {
  const diff = inputTime(b) - inputTime(a);
  if (diff !== 0 && Number.isFinite(diff)) return diff;
  if (inputTime(a) !== inputTime(b)) return inputTime(a) === Number.NEGATIVE_INFINITY ? 1 : -1;
  return ORB_ATTENTION_WEIGHT[a.status] - ORB_ATTENTION_WEIGHT[b.status];
}

function byAttention(a: OrbEntry, b: OrbEntry): number {
  return ORB_ATTENTION_WEIGHT[a.status] - ORB_ATTENTION_WEIGHT[b.status] || byRecent(a, b);
}

export interface OrderedOrb {
  /** 当前会话（不进列表，只在头部显示、外圈最后一段）。 */
  current: OrbEntry | null;
  pinned: OrbEntry[];
  auto: OrbEntry[];
  /** pinned + auto：列表顺序，也是 1–9 / 单击球的目标顺序。 */
  all: OrbEntry[];
}

/**
 * 列表排序：手动置顶（按置顶顺序）→ 其余按排序模式。
 * 「最近输入优先」只看 lastInputAt——切换面板不改它，所以切换不会刷新排序。
 */
export function orderOrbEntries(
  entries: readonly OrbEntry[],
  options: { sort: CCChanOrbSort; pinned: readonly string[] },
): OrderedOrb {
  const current = entries.find((entry) => entry.active) ?? null;
  const rest = entries.filter((entry) => entry !== current);
  const byId = new Map(rest.map((entry) => [entry.sessionId, entry]));
  const pinned = options.pinned
    .map((id) => byId.get(id))
    .filter((entry): entry is OrbEntry => Boolean(entry));
  const pinnedIds = new Set(pinned.map((entry) => entry.sessionId));
  const compare = options.sort === "attention" ? byAttention : byRecent;
  const auto = rest
    .filter((entry) => !pinnedIds.has(entry.sessionId))
    .sort((a, b) => compare(a, b) || a.sessionId.localeCompare(b.sessionId));
  return { current, pinned, auto, all: [...pinned, ...auto] };
}

export interface RingSegment {
  status: PetStatus;
  startDeg: number;
  endDeg: number;
}

/** 外圈：一段一个会话，从 12 点顺时针 = 列表顺序，当前会话排最后；段间留缝。 */
export function orbRingSegments(ordered: OrderedOrb, gapDeg = ORB_RING_GAP_DEG): RingSegment[] {
  const list = ordered.current ? [...ordered.all, ordered.current] : ordered.all;
  if (list.length === 0) return [];
  const span = 360 / list.length;
  const half = Math.min(gapDeg, span / 2) / 2;
  return list.map((entry, index) => ({
    status: entry.status,
    startDeg: index * span + half,
    endDeg: (index + 1) * span - half,
  }));
}

/** 分段 → conic-gradient；没有会话时整圈中性色。 */
export function orbRingGradient(segments: readonly RingSegment[]): string {
  if (segments.length === 0) return `conic-gradient(${PET_STATUS_COLOR.idle} 0deg 360deg)`;
  const stops: string[] = [];
  let cursor = 0;
  for (const segment of segments) {
    stops.push(`transparent ${cursor}deg ${segment.startDeg}deg`);
    stops.push(`${PET_STATUS_COLOR[segment.status]} ${segment.startDeg}deg ${segment.endDeg}deg`);
    cursor = segment.endDeg;
  }
  stops.push(`transparent ${cursor}deg 360deg`);
  return `conic-gradient(${stops.join(", ")})`;
}

export interface OrbCenter {
  /** 等你回复 + 出错。 */
  count: number;
  /** 有等你回复 = warning；只有出错 = danger；0 = null（显示网格图标）。 */
  tone: "warning" | "danger" | null;
  waiting: number;
  /** 全部空闲（含没有会话）：球整体降低不透明度。 */
  calm: boolean;
}

export function orbCenter(entries: readonly SessionPetEntry[]): OrbCenter {
  const waiting = entries.filter((entry) => entry.status === "needsInput").length;
  const errors = entries.filter((entry) => entry.status === "blocked").length;
  const count = waiting + errors;
  return {
    count,
    tone: waiting > 0 ? "warning" : errors > 0 ? "danger" : null,
    waiting,
    calm: entries.every((entry) => entry.status === "idle"),
  };
}

/** 单击球的目标：列表展开时去高亮行，否则去第 1 名。 */
export function orbClickTarget(ordered: OrderedOrb, open: boolean, highlight: number): OrbEntry | null {
  return ordered.all[open ? highlight : 0] ?? ordered.all[0] ?? null;
}

/** 向后端申请的列表高度（超出上限由面板内部滚动）。 */
export function orbPanelHeight(ordered: OrderedOrb): number {
  const m = ORB_PANEL_METRICS;
  const sections = (ordered.pinned.length > 0 ? 1 : 0) + 1;
  const body = ordered.all.length === 0 ? m.empty : ordered.all.length * m.row;
  return Math.min(ORB_PANEL_MAX_HEIGHT, m.header + m.listPadding + m.current + sections * m.section + body);
}

export type InputAge =
  | { key: "never" }
  | { key: "justNow" }
  | { key: "seconds" | "minutes" | "hours"; count: number };

export function inputAge(lastInputAt: number | null, now: number): InputAge {
  if (lastInputAt === null) return { key: "never" };
  const seconds = Math.max(0, Math.floor((now - lastInputAt) / 1000));
  if (seconds < 5) return { key: "justNow" };
  if (seconds < 60) return { key: "seconds", count: seconds };
  if (seconds < 3600) return { key: "minutes", count: Math.floor(seconds / 60) };
  return { key: "hours", count: Math.floor(seconds / 3600) };
}

export interface OrbLayout {
  expanded: boolean;
  width: number;
  height: number;
  orbX: number;
  orbY: number;
  alignRight: boolean;
  openUp: boolean;
}

export const COLLAPSED_ORB_LAYOUT: OrbLayout = {
  expanded: false,
  width: ORB_WINDOW,
  height: ORB_WINDOW,
  orbX: 0,
  orbY: 0,
  alignRight: false,
  openUp: false,
};

/** 后端不可用（Web 壳 / 测试）时的本地展开布局：向右下展开。 */
export function localExpandedLayout(panelHeight: number): OrbLayout {
  return {
    expanded: true,
    width: ORB_PANEL_WIDTH,
    height: ORB_WINDOW + ORB_PANEL_GAP + panelHeight,
    orbX: 0,
    orbY: 0,
    alignRight: false,
    openUp: false,
  };
}

/** 列表在窗口内的矩形：跟随球格，朝后端给的方向展开，夹在窗口内。 */
export function orbPanelRect(layout: OrbLayout): { x: number; y: number; width: number; height: number } {
  const width = Math.min(ORB_PANEL_WIDTH, layout.width);
  const height = Math.max(0, layout.height - ORB_WINDOW - ORB_PANEL_GAP);
  const rawX = layout.alignRight ? layout.orbX + ORB_WINDOW - width : layout.orbX;
  const rawY = layout.openUp ? layout.orbY - ORB_PANEL_GAP - height : layout.orbY + ORB_WINDOW + ORB_PANEL_GAP;
  return {
    x: Math.min(Math.max(0, rawX), Math.max(0, layout.width - width)),
    y: Math.min(Math.max(0, rawY), Math.max(0, layout.height - height)),
    width,
    height,
  };
}
