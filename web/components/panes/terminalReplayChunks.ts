const REPLAY_CHUNK_CHARS = 32 * 1024;
const REPLAY_BUDGET_MS = 8;

/**
 * 回放窗口 / gap 恢复的起始切割点不保证落在转义序列边界上：首块可能是丢了 ESC
 * 头的序列尾（如 `[38;2;68;70;75;48;2;50;55;58m`、`;58m`）。xterm 在 ground 态会
 * 把这种断头尾当正文打印，而 TUI 差量重绘不清未变单元格 → 乱码驻留屏幕。
 *
 * 判定保守：CSI 残尾必须含数字参数（排除 `[INFO]`、散文、日期等普通文本开头），
 * OSC 残尾以 BEL 收尾且不含换行/ESC。切不掉就原样返回——宁可偶发花屏一帧，
 * 不误吃正文。
 */
const CSI_TAIL_WITH_FINAL = /^\[?[\d;:?]*\d[\d;:]*[\x40-\x7e]/;
const CSI_TAIL_OPEN_ENDED = /^\[?[\d;:?]+(?=\x1b)/;
// OSC 残尾（`]0;title\x07` / `8;;url\x07` 丢头形态）必须先于 CSI 判定：
// `8;;url` 的前缀同样满足 CSI 参数形态，会被误切到第一个字母。
const OSC_TAIL = /^\]?\d+(?:;\d*)*?(?:;[^\x07\x1b\r\n]*)?\x07/;
const MAX_LEADING_TAIL = 4096;

export function dropLeadingEscapeTail(chunk: string): string {
  if (!chunk || chunk.charCodeAt(0) === 0x1b) return chunk;
  for (const pattern of [OSC_TAIL, CSI_TAIL_WITH_FINAL, CSI_TAIL_OPEN_ENDED]) {
    const match = pattern.exec(chunk);
    if (match && match[0].length <= MAX_LEADING_TAIL) return chunk.slice(match[0].length);
  }
  return chunk;
}

interface ReplayWriteOptions {
  canWrite?: () => boolean;
  chunkChars?: number;
  now?: () => number;
  yieldToMain?: () => Promise<void>;
  /** delta 窗口起点可能被切在序列中段：写入前丢弃首块的断头序列尾。 */
  dropLeadingEscapeTail?: boolean;
}

/** Keep surrogate pairs and CSI sequences intact before stateless color filters. */
function chunkEnd(data: string, start: number, limit: number): number {
  let end = Math.min(start + limit, data.length);
  if (end === data.length) return end;
  const last = data.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const localEscape = data.slice(start, end).lastIndexOf("\x1b");
  const escape = localEscape < 0 ? -1 : start + localEscape;
  if (escape >= start && /^\x1b(?:\[[0-?]*[ -/]*)?$/.test(data.slice(escape, end))) {
    if (escape > start) return escape;
    // An unusually long CSI must remain intact for stateless photo transforms.
    while (end < data.length && !(data.charCodeAt(end) >= 0x40 && data.charCodeAt(end) <= 0x7e)) end++;
    if (end < data.length) end++;
  }
  return end;
}

/** Slice BEFORE rendering/stripping and await every write callback. */
export async function writeTerminalReplay(
  data: string,
  write: (chunk: string) => Promise<void>,
  options: ReplayWriteOptions = {},
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const yieldToMain = options.yieldToMain ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const limit = Math.max(256, options.chunkChars ?? REPLAY_CHUNK_CHARS);
  const payload = options.dropLeadingEscapeTail ? dropLeadingEscapeTail(data) : data;
  let lastYield = now();
  let offset = 0;
  while (offset < payload.length) {
    if (options.canWrite && !options.canWrite()) throw new Error("Terminal replay cancelled");
    const end = chunkEnd(payload, offset, limit);
    await write(payload.slice(offset, end));
    offset = end;
    if (offset < payload.length && now() - lastYield >= REPLAY_BUDGET_MS) {
      await yieldToMain();
      lastYield = now();
    }
  }
  if (options.canWrite && !options.canWrite()) throw new Error("Terminal replay cancelled");
}
