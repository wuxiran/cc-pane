import { terminalService } from "@/services/terminalService";
import type { TerminalStatusInfo } from "@/types";

/**
 * `get_all_terminal_status` 的页面级共享缓存。
 *
 * 该查询返回全部会话，结果对所有终端视图通用；N 个视图各自每 2s 查一次就是
 * N 倍的 daemon 往返（每次一条 TCP 连接）。这里把并发请求合并成一次、短期内
 * 复用结果——调用方拿到的是"最近 `maxAgeMs` 内"的状态，对 watchdog 这种
 * 以十几秒为窗口的判定足够。
 */
const DEFAULT_MAX_AGE_MS = 1_500;

let cached: TerminalStatusInfo[] | null = null;
let cachedAt = 0;
let inflight: Promise<TerminalStatusInfo[]> | null = null;

export function getAllTerminalStatusShared(
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now: () => number = Date.now,
): Promise<TerminalStatusInfo[]> {
  if (cached && now() - cachedAt < maxAgeMs) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = terminalService
    .getAllStatus()
    .then((statuses) => {
      cached = statuses;
      cachedAt = now();
      return statuses;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 测试用：清空缓存。 */
export function resetTerminalStatusCacheForTests(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}
