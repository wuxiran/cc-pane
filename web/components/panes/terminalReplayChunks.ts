const REPLAY_CHUNK_CHARS = 32 * 1024;
const REPLAY_BUDGET_MS = 8;

interface ReplayWriteOptions {
  canWrite?: () => boolean;
  chunkChars?: number;
  now?: () => number;
  yieldToMain?: () => Promise<void>;
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
  let lastYield = now();
  let offset = 0;
  while (offset < data.length) {
    if (options.canWrite && !options.canWrite()) throw new Error("Terminal replay cancelled");
    const end = chunkEnd(data, offset, limit);
    await write(data.slice(offset, end));
    offset = end;
    if (offset < data.length && now() - lastYield >= REPLAY_BUDGET_MS) {
      await yieldToMain();
      lastYield = now();
    }
  }
  if (options.canWrite && !options.canWrite()) throw new Error("Terminal replay cancelled");
}
