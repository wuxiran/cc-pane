/**
 * 终端会话录制/回放格式 + 录制器——WebGL 花屏复现台用。
 *
 * 花屏是「用量/时序触发」的（Claude 的中文字形 churn 大 → 图集压力 → 花；Codex 不花）。
 * 要在诊断台可靠复现，必须回放**真实录下的字节流**而非合成串。本模块提供：
 *  - 录制器：钩在终端写入路径上，把原始输出按相对时间戳存成 cast；
 *  - 键盘和弦：Ctrl+Alt+Shift+R 开/停录制活动终端；Ctrl+Alt+Shift+G 打开诊断台。
 *
 * 默认全程 no-op（未 arm 时 capture 立即返回），不影响生产终端。
 */

export interface TerminalCastEvent {
  /** 距上一事件的毫秒数 */
  d: number;
  /** 该次写入终端的原始数据（xterm 已按 UTF-8 解码的字符串） */
  s: string;
}

export interface TerminalCast {
  v: 1;
  sessionId: string;
  startedAt: number;
  cols: number | null;
  rows: number | null;
  meta: {
    userAgent: string;
    platform: string;
  };
  events: TerminalCastEvent[];
}

type RecorderState = {
  armed: boolean;
  sessionId: string | null;
  startedAt: number;
  lastAt: number;
  events: TerminalCastEvent[];
  cols: number | null;
  rows: number | null;
};

const state: RecorderState = {
  armed: false,
  sessionId: null,
  startedAt: 0,
  lastAt: 0,
  events: [],
  cols: null,
  rows: null,
};

/** 由终端 resize 路径调用，记录几何。回放需与录制几何一致，否则 TUI 光标定位错位。 */
export function noteTerminalGeometry(sessionId: string, cols: number, rows: number): void {
  if (!state.armed) return;
  if (state.sessionId !== null && state.sessionId !== sessionId) return;
  state.cols = cols;
  state.rows = rows;
}

let onStatusChange: ((recording: boolean, count: number, sessionId: string | null) => void) | null = null;

export function setCastRecorderStatusListener(
  cb: ((recording: boolean, count: number, sessionId: string | null) => void) | null,
): void {
  onStatusChange = cb;
}

function notify() {
  onStatusChange?.(state.armed, state.events.length, state.sessionId);
}

/** 由终端写入路径调用。未 arm 时立即返回，是安全的 no-op。 */
export function captureTerminalWrite(sessionId: string, data: string): void {
  if (!state.armed || !data) return;
  // arm 后锁定第一个产生输出的会话，只录它。
  if (state.sessionId === null) {
    state.sessionId = sessionId;
    state.startedAt = performance.now();
    state.lastAt = state.startedAt;
  } else if (state.sessionId !== sessionId) {
    return;
  }
  const now = performance.now();
  state.events.push({ d: Math.round(now - state.lastAt), s: data });
  state.lastAt = now;
  if (state.events.length % 20 === 0) notify();
}

export function isRecording(): boolean {
  return state.armed;
}

export function startRecording(): void {
  state.armed = true;
  state.sessionId = null;
  state.startedAt = 0;
  state.lastAt = 0;
  state.events = [];
  state.cols = null;
  state.rows = null;
  notify();
}

/** 停止并返回 cast（无事件返回 null） */
export function stopRecording(): TerminalCast | null {
  state.armed = false;
  const events = state.events;
  const sessionId = state.sessionId;
  notify();
  if (!sessionId || events.length === 0) return null;
  return {
    v: 1,
    sessionId,
    startedAt: Date.now(),
    cols: state.cols,
    rows: state.rows,
    meta: {
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      platform:
        typeof document !== "undefined"
          ? (document.documentElement.dataset.platform ?? "unknown")
          : "unknown",
    },
    events,
  };
}

export function downloadCast(cast: TerminalCast): void {
  const blob = new Blob([JSON.stringify(cast)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cc-panes-terminal-${cast.sessionId.slice(0, 8)}-${cast.startedAt}.cast.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseCast(text: string): TerminalCast {
  const obj = JSON.parse(text) as TerminalCast;
  if (obj.v !== 1 || !Array.isArray(obj.events)) {
    throw new Error("Unrecognized cast format");
  }
  return obj;
}

/**
 * 安装开发者键盘和弦（只装一次）。
 *  - Ctrl+Alt+Shift+R：开始/停止录制活动终端；停止时下载 cast。
 *  - Ctrl+Alt+Shift+G：打开 WebGL 诊断台（当前窗口跳 ?mode=webgl-lab）。
 * 通过 toast 给最小反馈（无 toast 环境则退回 console）。
 */
let installed = false;
export function installTerminalCastShortcuts(
  toast?: (msg: string) => void,
): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const say = (m: string) => (toast ? toast(m) : console.info("[cast]", m));

  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey && e.shiftKey)) return;
    const key = e.key.toLowerCase();
    if (key === "r") {
      e.preventDefault();
      if (isRecording()) {
        const cast = stopRecording();
        if (cast) {
          downloadCast(cast);
          say(`录制已停止，${cast.events.length} 事件，已下载 cast`);
        } else {
          say("录制已停止（无输出，未生成 cast）");
        }
      } else {
        startRecording();
        say("已开始录制——请在目标终端制造花屏，再按一次停止");
      }
    } else if (key === "g") {
      e.preventDefault();
      const url = new URL(window.location.href);
      url.searchParams.set("mode", "webgl-lab");
      window.location.href = url.toString();
    }
  });
}
