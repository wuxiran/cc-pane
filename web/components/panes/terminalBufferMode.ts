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

export interface SgrBackgroundStripper {
  push(chunk: string): string;
  flush(): string;
}

const MAX_PENDING_SGR_LENGTH = 128;

function parseSgrCode(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function stripSgrBackgroundSequence(sequence: string): string {
  if (!sequence.endsWith("m")) return sequence;
  const body = sequence.slice(2, -1);
  const params = body === "" ? [""] : body.split(";");
  const kept: string[] = [];
  let changed = false;
  let hasBackgroundReset = false;
  const resetBackground = () => {
    changed = true;
    if (!hasBackgroundReset) {
      kept.push("49");
      hasBackgroundReset = true;
    }
  };
  for (let index = 0; index < params.length; index += 1) {
    const group = params[index];
    const colonParams = group.split(":");
    const value = parseSgrCode(colonParams[0]);
    if (value === null) {
      kept.push(group);
      continue;
    }
    if (value === 48) {
      resetBackground();
      // Colon notation (`48:2::r:g:b`, `48:5:n`) keeps the complete color
      // in one semicolon group. Mixed notation is accepted defensively by
      // consuming the same number of following semicolon parameters.
      if (colonParams.length > 1) {
        const mode = colonParams[1];
        if (mode === "2") {
          const expectedParts = colonParams[2] === "" ? 6 : 5;
          index += Math.max(0, expectedParts - colonParams.length);
        }
        if (mode === "5" && colonParams.length < 3) index += 1;
      } else {
        const mode = params[index + 1];
        index += mode === "5" ? 2 : mode === "2" ? 4 : 0;
      }
      continue;
    }
    // Reverse video swaps the foreground into an opaque cell background. A
    // transparent CLI surface drops the enable but retains a later `27` so
    // state that predates the filter can still be cleared.
    if (value === 7) {
      changed = true;
      continue;
    }
    if (value === 49 || (value >= 40 && value <= 47) || (value >= 100 && value <= 107)) {
      resetBackground();
      continue;
    }
    kept.push(group);
  }
  if (!changed) return sequence;
  return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
}

export function createSgrBackgroundStripper(): SgrBackgroundStripper {
  let pending = "";

  return {
    push(chunk: string): string {
      const combined = pending + chunk;
      pending = "";
      let output = "";
      let cursor = 0;
      while (cursor < combined.length) {
        const start = combined.indexOf("\x1b[", cursor);
        if (start < 0) {
          const danglingEscape = combined.endsWith("\x1b") ? "\x1b" : "";
          output += combined.slice(cursor, combined.length - danglingEscape.length);
          pending = danglingEscape;
          break;
        }
        output += combined.slice(cursor, start);
        let end = start + 2;
        while (end < combined.length && !(combined.charCodeAt(end) >= 0x40 && combined.charCodeAt(end) <= 0x7e)) {
          end += 1;
        }
        if (end >= combined.length) {
          const tail = combined.slice(start);
          if (tail.length <= MAX_PENDING_SGR_LENGTH) pending = tail;
          else output += tail;
          break;
        }
        const sequence = combined.slice(start, end + 1);
        output += stripSgrBackgroundSequence(sequence);
        cursor = end + 1;
      }
      return output;
    },
    flush(): string {
      const remaining = pending;
      pending = "";
      return remaining;
    },
  };
}

/**
 * Removes SGR styles that would paint opaque cells in a transparent terminal:
 * explicit background colors and reverse-video enables.
 * Checkpoint/SerializeAddon data is already a rendered VT stream, so it must
 * not pass through the stateful alt-screen renderer; this helper is stateless.
 */
export function stripSgrBackgroundColors(data: string): string {
  const stripper = createSgrBackgroundStripper();
  return stripper.push(data) + stripper.flush();
}

/**
 * 剥离时真实命中的 alt-screen 转换回调（docs/73 §2.x 的 1049 探针）。
 *
 * 与 `detectAlternateBufferTransitions(rawChunk)` 的关键差别：这里在跨 chunk
 * 重组**之后**检测——PTY 把 `\x1b[?1049h` 切成两半时逐 chunk 检测必漏计，
 * 而 stripper 的 pending 机制恰好完成了重组，是唯一无漏计的观测点。
 */
export type AlternateBufferTransitionListener = (transition: AlternateBufferTransition) => void;

/**
 * 跨 chunk 安全的剥离器。
 *
 * PTY 会把 `\x1b[?1049h` 切成任意两段（例如 `\x1b[?10` + `49h`），逐 chunk 跑正则
 * 时两段都不匹配 → 序列漏网 → 目标 CLI 真的进了 alt screen。这里把可能构成不完整
 * 序列的尾部留到下一个 chunk 再判定。每个终端实例应各自持有一个 stripper。
 */
export function createAlternateBufferStripper(
  onTransition?: AlternateBufferTransitionListener,
): AlternateBufferStripper {
  let pending = "";

  const release = (data: string): string => {
    if (onTransition && data) {
      for (const transition of detectAlternateBufferTransitions(data)) {
        onTransition(transition);
      }
    }
    return stripAlternateBufferSequences(data);
  };

  return {
    push(chunk: string): string {
      const combined = pending + chunk;
      const tail = PARTIAL_SEQUENCE_TAIL.exec(combined);

      if (tail && tail[0].length <= MAX_PARTIAL_TAIL_LENGTH) {
        pending = tail[0];
        return release(combined.slice(0, combined.length - pending.length));
      }

      pending = "";
      return release(combined);
    },
    flush(): string {
      const remaining = pending;
      pending = "";
      return release(remaining);
    },
  };
}

export interface TerminalDataRenderContext {
  /** 当前 CLI 是否需要把输出留在主缓冲区。false 时数据原样透传。 */
  keepCliOutputInNormalBuffer: boolean;
  /** 当前会话 id；变化时丢弃上一会话的扣留残留，避免串台。 */
  sessionId: string | null;
  /** 托管 CLI 使用透明表面时，移除会绘制不透明单元格的 SGR 样式。 */
  stripBackgroundColors?: boolean;
}

export interface TerminalDataRenderer {
  /** 把一个 PTY chunk 变换成可以写进 xterm 的数据。 */
  render(data: string, context: TerminalDataRenderContext): string;
}

export interface TerminalDataRendererOptions {
  /** 剥离路径上（跨 chunk 重组后）命中的 alt-screen 转换。旁路模式不触发。 */
  onStrippedTransition?: AlternateBufferTransitionListener;
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
export function createTerminalDataRenderer(
  options?: TerminalDataRendererOptions,
): TerminalDataRenderer {
  let stripper: AlternateBufferStripper | null = null;
  let backgroundStripper: SgrBackgroundStripper | null = null;
  let activeSessionId: string | null = null;

  return {
    render(data: string, context: TerminalDataRenderContext): string {
      const { sessionId } = context;
      if (sessionId && activeSessionId && sessionId !== activeSessionId) {
        stripper = null;
        backgroundStripper = null;
      }
      if (sessionId) activeSessionId = sessionId;

      const rendered = context.stripBackgroundColors
        ? (backgroundStripper ??= createSgrBackgroundStripper()).push(data)
        : (backgroundStripper = null, data);
      if (!context.keepCliOutputInNormalBuffer) {
        stripper = null;
        return rendered;
      }

      stripper ??= createAlternateBufferStripper(options?.onStrippedTransition);
      return stripper.push(rendered);
    },
  };
}

/** 终端缓冲模式：strip = 剥掉 alt-screen 保滚动历史；native = 原样透传（TUI 用备用屏）。 */
export type TerminalBufferMode = "strip" | "native";

/**
 * 各 CLI 的默认缓冲模式（docs/73 §2.x 复审 + §2.x.1 Codex 评审结论）：
 * - claude：维持剥离——Ink 内联输出，对话流真的在主缓冲区里，滚动历史有实价值；
 *   是否连 claude 也翻回 native，等 1049 探针数据（它可能根本不发 alt-screen 序列）。
 * - codex / opencode：翻回原生 alt-screen——全屏 TUI 的"滚动历史"只是一帧帧残影，
 *   收益薄；而剥离的代价（spinner 锚点被钳、scrollback 永久污染）已被两例活体证实。
 * - 其它 CLI：从来就是透传，等价 native。
 */
const DEFAULT_STRIP_CLI_TOOLS = new Set(["claude"]);

/**
 * 解析某个 CLI 的缓冲模式。`overrides` 来自设置 `terminal.cliBufferModes`
 * （用户级逃生阀：出问题的用户可按 CLI 翻转，无效值忽略走默认）。
 */
export function resolveTerminalBufferMode(
  cliToolId: string,
  overrides?: Record<string, string> | null,
): TerminalBufferMode {
  const override = overrides?.[cliToolId];
  if (override === "strip" || override === "native") return override;
  return DEFAULT_STRIP_CLI_TOOLS.has(cliToolId) ? "strip" : "native";
}
