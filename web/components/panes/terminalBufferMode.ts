export interface AlternateBufferTransition {
  mode: string;
  action: "enter" | "exit";
}

/**
 * DECSET/DECRST 私有模式序列：`ESC [ ? <params> (h|l)`。
 * params 是 `;` 分隔的数字列表——终端允许 `\x1b[?1049;25h` 这种组合写法，
 * 因此不能只匹配单参数形式。
 */
const PRIVATE_MODE_SEQUENCE_SOURCE = "\\x1b\\[\\?(\\d+(?:;\\d+)*)(h|l)";

const ALTERNATE_BUFFER_MODES = new Set(["1049", "1047", "47"]);

/**
 * 可能构成不完整私有模式序列的尾部形态：`\x1b`、`\x1b[`、`\x1b[?`、`\x1b[?1049;`…
 * 命中时该尾部需要留到下一个 chunk 再判定。
 */
const PARTIAL_SEQUENCE_TAIL = /\x1b(?:\[(?:\?[\d;]*)?)?$/;

/** 残留缓冲上限：超过说明尾部并非未完成序列，直接放行，避免无限扣留输出。 */
const MAX_PARTIAL_TAIL_LENGTH = 32;

export function detectAlternateBufferTransitions(data: string): AlternateBufferTransition[] {
  const transitions: AlternateBufferTransition[] = [];
  const regex = new RegExp(PRIVATE_MODE_SEQUENCE_SOURCE, "g");

  for (const match of data.matchAll(regex)) {
    const action = match[2] === "h" ? "enter" : "exit";
    for (const param of match[1].split(";")) {
      if (ALTERNATE_BUFFER_MODES.has(param)) {
        transitions.push({ mode: param, action });
      }
    }
  }

  return transitions;
}

/**
 * 剥掉 alt-screen 参数，保留同一序列里的其它私有模式。
 * `\x1b[?1049h` → ``，`\x1b[?1049;25h` → `\x1b[?25h`，`\x1b[?25h` 原样返回。
 */
export function stripAlternateBufferSequences(data: string): string {
  return data.replace(new RegExp(PRIVATE_MODE_SEQUENCE_SOURCE, "g"), (whole, params: string, terminator: string) => {
    const kept = params.split(";").filter((param) => !ALTERNATE_BUFFER_MODES.has(param));
    if (kept.length === params.split(";").length) return whole;
    return kept.length > 0 ? `\x1b[?${kept.join(";")}${terminator}` : "";
  });
}

export interface AlternateBufferStripper {
  /** 处理一个 PTY chunk，返回可以立即写进 xterm 的部分。 */
  push(chunk: string): string;
  /** 会话结束时调用，吐出仍被扣留的尾部残留。 */
  flush(): string;
}

/**
 * 跨 chunk 安全的剥离器。
 *
 * PTY 会把 `\x1b[?1049h` 切成任意两段（例如 `\x1b[?10` + `49h`），逐 chunk 跑正则
 * 时两段都不匹配 → 序列漏网 → 目标 CLI 真的进了 alt screen。这里把可能构成不完整
 * 序列的尾部留到下一个 chunk 再判定。每个终端实例应各自持有一个 stripper。
 */
export function createAlternateBufferStripper(): AlternateBufferStripper {
  let pending = "";

  return {
    push(chunk: string): string {
      const combined = pending + chunk;
      const tail = PARTIAL_SEQUENCE_TAIL.exec(combined);

      if (tail && tail[0].length <= MAX_PARTIAL_TAIL_LENGTH) {
        pending = tail[0];
        return stripAlternateBufferSequences(combined.slice(0, combined.length - pending.length));
      }

      pending = "";
      return stripAlternateBufferSequences(combined);
    },
    flush(): string {
      const remaining = pending;
      pending = "";
      return stripAlternateBufferSequences(remaining);
    },
  };
}

export interface TerminalDataRenderContext {
  /** 当前 CLI 是否需要把输出留在主缓冲区。false 时数据原样透传。 */
  keepCliOutputInNormalBuffer: boolean;
  /** 当前会话 id；变化时丢弃上一会话的扣留残留，避免串台。 */
  sessionId: string | null;
}

export interface TerminalDataRenderer {
  /** 把一个 PTY chunk 变换成可以写进 xterm 的数据。 */
  render(data: string, context: TerminalDataRenderContext): string;
}

/**
 * TerminalView 渲染前的数据变换，是 stripper 接进生产路径的那一层。
 *
 * 与裸 stripper 的差别都在状态管理上：
 * - 旁路（`keepCliOutputInNormalBuffer` 为 false）时数据**不喂给 stripper**，
 *   并丢弃已有 stripper——否则 CLI 中途切换后残留缓冲会污染后续输出。
 * - 会话切换（重连/换绑到别的 sessionId）时丢弃残留，防止上一会话的尾部串到新会话。
 *   `null → sessionId` 不算切换：attach 回放先于 `currentSessionIdRef` 赋值发生，
 *   那仍是同一条流。
 *
 * 每个终端实例应各自持有一个 renderer（TerminalView 里用 `useRef`）。
 */
export function createTerminalDataRenderer(): TerminalDataRenderer {
  let stripper: AlternateBufferStripper | null = null;
  let activeSessionId: string | null = null;

  return {
    render(data: string, context: TerminalDataRenderContext): string {
      if (!context.keepCliOutputInNormalBuffer) {
        stripper = null;
        activeSessionId = null;
        return data;
      }

      const { sessionId } = context;
      if (sessionId && activeSessionId && sessionId !== activeSessionId) {
        stripper = null;
      }
      if (sessionId) activeSessionId = sessionId;

      stripper ??= createAlternateBufferStripper();
      return stripper.push(data);
    },
  };
}

const NORMAL_BUFFER_CLI_TOOLS = new Set(["claude", "codex"]);

export function shouldKeepCliOutputInNormalBuffer(cliToolId: string): boolean {
  return NORMAL_BUFFER_CLI_TOOLS.has(cliToolId);
}
