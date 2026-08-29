/**
 * 全屏 TUI 的滚轮距离模型（把一次 wheel 事件解成「该发几个鼠标报告」）。
 *
 * 为什么需要它：xterm 的 `consumeWheelEvent` 会把小像素增量抑制掉，一次滚轮
 * 最多换来一个鼠标报告。对**自己处理滚动且开了鼠标上报的全屏 TUI**（如
 * opencode）来说，这意味着滚一下只动一行，手感远慢于普通缓冲区的 scrollback。
 * 注意 grok **不在此列**：0.2.101 二进制取证只有鼠标上报的关闭序列（1000l/1002l/
 * 1003l），从不开启——grok 会话不会命中本路径（它的滚动靠 inline scrollback
 * 或 fullscreen 下的键盘/方向键）。
 *
 * 做法参考 Orca 的 `pane-terminal-tui-wheel-reports.ts`：按事件实际代表的
 * **行距**解出报告数，由调用方补发等量的 line-mode WheelEvent。
 *
 * 三类输入分开处理，因为它们的物理含义不同：
 * - **鼠标滚轮**（离散刻度）：一格就该跳若干行，且连续快滚要有加速；
 * - **触控板**（连续像素流）：1:1 映射物理距离，不压缩、不加速，否则惯性滚动失真；
 * - **行/页模式**（`deltaMode` 非 pixel）：浏览器已经给出行数，直接用。
 */

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** 像素流里超过这个增量就当离散滚轮刻度，而不是触控板的连续位移。 */
const DISCRETE_PIXEL_WHEEL_DELTA_MIN = 50;
/** 传统 `wheelDelta` 的一格；Chromium/WebView2 仍在提供这个字段。 */
const LEGACY_MOUSE_WHEEL_DELTA_UNIT = 120;
const LEGACY_MOUSE_WHEEL_DELTA_MIN = 100;
/** 拿不到真实字号时的兜底行高，只用于把像素换算成行。 */
const DEFAULT_TERMINAL_CELL_HEIGHT = 16;

/** 压缩曲线的增益：滚得越多增长越慢，避免一格甩过整屏。 */
const ACCELERATED_DISTANCE_GAIN = 1.6;
/** 连滚判定：间隔小于这个值算「全速」。 */
const BURST_FULL_INTERVAL_MS = 16;
/** 超过这个间隔就不算连滚，加速清零。 */
const BURST_MAX_INTERVAL_MS = 45;
const BURST_MAX_BONUS_ROWS = 3;
/** 连滚加速需要几个事件爬满。 */
const BURST_RAMP_EVENTS = 4;
/** 本次距离比上次衰减到这个比例以下 = 惯性尾巴，不给加速。 */
const MOMENTUM_TAIL_DECAY_RATIO = 0.85;
const COMPRESSED_MAX_ROWS_PER_EVENT = 6;
const BURST_MAX_ROWS_PER_EVENT = 9;

export const TERMINAL_TUI_WHEEL_MULTIPLIER_DEFAULT = 1;
export const TERMINAL_TUI_WHEEL_MULTIPLIER_MIN = 1;
export const TERMINAL_TUI_WHEEL_MULTIPLIER_MAX = 10;

interface WheelEventWithLegacyDelta {
  wheelDelta?: number;
  wheelDeltaY?: number;
}

/** 只依赖这几个字段，便于单测直接喂普通对象。 */
export type TerminalTuiWheelEventInput = Pick<WheelEvent, "deltaY"> &
  Partial<Pick<WheelEvent, "deltaMode" | "timeStamp">> &
  WheelEventWithLegacyDelta;

export interface TerminalTuiWheelMetrics {
  cellHeight?: number;
  rows?: number;
}

/**
 * 跨事件累计的状态。`pendingRows` 让不足一行的余量结转到下一次，
 * 否则慢速触控板会因为每次都被 `trunc` 掉而完全滚不动。
 */
export interface TerminalTuiWheelDistanceState {
  fastStreak: number;
  lastDistanceRows: number | null;
  lastInputAt: number | null;
  pendingDirection: -1 | 0 | 1;
  pendingRows: number;
}

export function createTerminalTuiWheelDistanceState(): TerminalTuiWheelDistanceState {
  return {
    fastStreak: 0,
    lastDistanceRows: null,
    lastInputAt: null,
    pendingDirection: 0,
    pendingRows: 0,
  };
}

export function resolveTerminalWheelDirection(event: Pick<WheelEvent, "deltaY">): -1 | 1 {
  return event.deltaY < 0 ? -1 : 1;
}

function legacyVerticalWheelDelta(event: TerminalTuiWheelEventInput): number | null {
  if (typeof event.wheelDeltaY === "number" && Number.isFinite(event.wheelDeltaY)) {
    return event.wheelDeltaY;
  }
  if (typeof event.wheelDelta === "number" && Number.isFinite(event.wheelDelta)) {
    return event.wheelDelta;
  }
  return null;
}

function hasDiscreteLegacyWheelDelta(event: TerminalTuiWheelEventInput): boolean {
  const legacyDelta = legacyVerticalWheelDelta(event);
  return legacyDelta !== null && Math.abs(legacyDelta) >= LEGACY_MOUSE_WHEEL_DELTA_MIN;
}

/** 离散刻度（真滚轮）判定：非像素模式，或像素增量/传统 delta 够大。 */
export function isDiscreteTerminalTuiWheelEvent(event: TerminalTuiWheelEventInput): boolean {
  if ((event.deltaMode ?? DOM_DELTA_PIXEL) !== DOM_DELTA_PIXEL) return true;
  if (Math.abs(event.deltaY) >= DISCRETE_PIXEL_WHEEL_DELTA_MIN) return true;
  return hasDiscreteLegacyWheelDelta(event);
}

function isTrackpadLikePixelWheelEvent(event: TerminalTuiWheelEventInput): boolean {
  return (
    (event.deltaMode ?? DOM_DELTA_PIXEL) === DOM_DELTA_PIXEL &&
    !hasDiscreteLegacyWheelDelta(event)
  );
}

function canBurstBoostWheelEvent(event: TerminalTuiWheelEventInput): boolean {
  if ((event.deltaMode ?? DOM_DELTA_PIXEL) !== DOM_DELTA_PIXEL) return true;
  return hasDiscreteLegacyWheelDelta(event);
}

function wheelInputTime(event: TerminalTuiWheelEventInput): number | null {
  return typeof event.timeStamp === "number" && Number.isFinite(event.timeStamp)
    ? event.timeStamp
    : null;
}

function normalizeCellHeight(cellHeight: number | undefined): number {
  return typeof cellHeight === "number" && Number.isFinite(cellHeight) && cellHeight > 0
    ? cellHeight
    : DEFAULT_TERMINAL_CELL_HEIGHT;
}

/** 把一次事件换算成「滚了多少行」。取 deltaY 与传统 wheelDelta 的较大者。 */
function resolveWheelDistanceRows(
  event: TerminalTuiWheelEventInput,
  metrics: TerminalTuiWheelMetrics,
): number {
  const deltaMode = event.deltaMode ?? DOM_DELTA_PIXEL;
  const deltaY = Math.abs(event.deltaY);
  const rowsFromDelta =
    deltaMode === DOM_DELTA_LINE
      ? deltaY
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * Math.max(1, metrics.rows ?? 1)
        : deltaY / normalizeCellHeight(metrics.cellHeight);
  const legacyDelta = legacyVerticalWheelDelta(event);
  const rowsFromLegacy =
    legacyDelta === null ? 0 : Math.abs(legacyDelta) / LEGACY_MOUSE_WHEEL_DELTA_UNIT;
  const rows = Math.max(rowsFromDelta, rowsFromLegacy);

  // 离散刻度至少算一行：否则高 DPI 下一格滚轮可能被算成 0.9 行而丢掉。
  return isDiscreteTerminalTuiWheelEvent(event) ? Math.max(1, rows) : rows;
}

/** 对数压缩：一格滚很多行时增长放缓，避免甩过头。 */
function compressWheelDistanceRows(rows: number): number {
  if (rows <= 1) return rows;
  return Math.min(
    COMPRESSED_MAX_ROWS_PER_EVENT,
    1 + Math.log2(rows) * ACCELERATED_DISTANCE_GAIN,
  );
}

/** 连续快滚的加成。惯性尾巴、间隔过大、拿不到时间戳都不给加成。 */
function resolveBurstWheelDistanceRows(
  event: TerminalTuiWheelEventInput,
  state: TerminalTuiWheelDistanceState,
  distanceRows: number,
): number {
  const resetStreak = () => {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
  };

  if (!canBurstBoostWheelEvent(event)) {
    resetStreak();
    return 0;
  }

  const currentInputAt = wheelInputTime(event);
  if (currentInputAt === null) {
    resetStreak();
    return 0;
  }

  const elapsedMs = state.lastInputAt === null ? null : currentInputAt - state.lastInputAt;
  const isMomentumTail =
    state.lastDistanceRows !== null &&
    distanceRows < state.lastDistanceRows * MOMENTUM_TAIL_DECAY_RATIO;
  state.lastDistanceRows = distanceRows;
  state.lastInputAt = currentInputAt;

  if (isMomentumTail || elapsedMs === null || elapsedMs < 0 || elapsedMs > BURST_MAX_INTERVAL_MS) {
    state.fastStreak = 0;
    return 0;
  }

  const cadence =
    elapsedMs <= BURST_FULL_INTERVAL_MS
      ? 1
      : (BURST_MAX_INTERVAL_MS - elapsedMs) / (BURST_MAX_INTERVAL_MS - BURST_FULL_INTERVAL_MS);
  state.fastStreak = Math.min(BURST_RAMP_EVENTS, state.fastStreak + 1);

  return BURST_MAX_BONUS_ROWS * cadence * (state.fastStreak / BURST_RAMP_EVENTS);
}

/**
 * 触控板像素流：1:1 映射，余量结转，**不压缩也不加速**。
 * 惯性滚动本身就是连续小增量，压缩会让它失真、加速会让它飞出去。
 */
function resolveTrackpadPixelWheelReportCount(
  event: TerminalTuiWheelEventInput,
  state: TerminalTuiWheelDistanceState,
  distanceRows: number,
): number | null {
  if (!isTrackpadLikePixelWheelEvent(event)) return null;

  const totalRows = state.pendingRows + distanceRows;
  const reports = Math.trunc(totalRows);
  state.pendingRows = totalRows - reports;
  return reports;
}

export function normalizeTerminalTuiWheelMultiplier(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TERMINAL_TUI_WHEEL_MULTIPLIER_DEFAULT;
  }
  return Math.round(
    Math.min(
      TERMINAL_TUI_WHEEL_MULTIPLIER_MAX,
      Math.max(TERMINAL_TUI_WHEEL_MULTIPLIER_MIN, value),
    ),
  );
}

/**
 * 解出本次事件该补发几个鼠标报告。
 *
 * 换向时清空累计量：否则反向滚的第一下会被上一方向的余量抵消掉。
 */
export function resolveTerminalTuiWheelReportCount(
  event: TerminalTuiWheelEventInput,
  multiplier: number,
  state: TerminalTuiWheelDistanceState,
  metrics: TerminalTuiWheelMetrics = {},
): number {
  const direction = resolveTerminalWheelDirection(event);
  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.fastStreak = 0;
    state.lastDistanceRows = null;
    state.lastInputAt = null;
    state.pendingRows = 0;
  }
  state.pendingDirection = direction;

  const distanceRows = resolveWheelDistanceRows(event, metrics);

  const trackpadReportCount = resolveTrackpadPixelWheelReportCount(event, state, distanceRows);
  if (trackpadReportCount !== null) return trackpadReportCount;

  const rows =
    Math.min(
      BURST_MAX_ROWS_PER_EVENT,
      compressWheelDistanceRows(distanceRows) +
        resolveBurstWheelDistanceRows(event, state, distanceRows),
    ) * normalizeTerminalTuiWheelMultiplier(multiplier);
  const totalRows = state.pendingRows + rows;
  const reports = Math.trunc(totalRows);
  state.pendingRows = totalRows - reports;
  return reports;
}
