/**
 * 后台（不可见）终端的写入积压缓冲。
 *
 * 背景：非活动标签页只是 `display: none`，TerminalView 仍保持挂载、output 回调仍全速
 * 把数据喂给 xterm。N 个后台会话同时刷屏 = N 份 parser + DOM renderer 抢主线程
 * （实测本机同时挂 18 个会话，见 docs/71 §3、docs/73 §4）。
 *
 * 策略是**合并而不是丢弃**：不可见期间把数据攒起来，可见时一次性写入。数据零丢失、
 * 顺序不变，省掉的是 N 次 parse + N 次渲染帧。积压超过上限时立刻整块 flush 一次，
 * 让内存有界——flush 仍是完整前缀，不破坏转义序列。
 */

export interface TerminalHiddenWriteBuffer {
  /**
   * 收下一个 chunk。
   * 返回应当立即写进 xterm 的数据；返回 `null` 表示已收进积压、暂时别写。
   */
  push(data: string): string | null;
  /** 取出全部积压（变可见、解绑会话时调用）。无积压时返回 `null`。 */
  drain(): string | null;
  /** 丢弃积压（换绑到别的会话时调用，避免上一会话的数据串到新会话）。 */
  reset(): void;
  pendingLength(): number;
}

/** 积压上限（字符数）。超过即整块 flush，保证内存有界。 */
const DEFAULT_MAX_PENDING_CHARS = 512 * 1024;

interface CreateTerminalHiddenWriteBufferOptions {
  /** 当前终端是否可见。可见时数据直通，不进积压。 */
  isVisible: () => boolean;
  maxPendingChars?: number;
  /** 触发上限 flush 时的观测钩子。 */
  onOverflowFlush?: (pendingLength: number) => void;
}

export function createTerminalHiddenWriteBuffer({
  isVisible,
  maxPendingChars = DEFAULT_MAX_PENDING_CHARS,
  onOverflowFlush,
}: CreateTerminalHiddenWriteBufferOptions): TerminalHiddenWriteBuffer {
  let pending: string[] = [];
  let pendingLength = 0;

  const takeAll = (): string | null => {
    if (pendingLength === 0) return null;
    const merged = pending.join("");
    pending = [];
    pendingLength = 0;
    return merged;
  };

  return {
    push(data: string): string | null {
      if (!data) return null;

      if (isVisible()) {
        // 可见时直通。但仍要把残留的积压拼在前面：可见性翻转与本次 push 的先后
        // 不由本模块决定，漏拼会让积压数据永远排在后面 → 乱序。
        const drained = takeAll();
        return drained === null ? data : drained + data;
      }

      pending.push(data);
      pendingLength += data.length;
      if (pendingLength < maxPendingChars) return null;

      onOverflowFlush?.(pendingLength);
      return takeAll();
    },

    drain: takeAll,

    reset(): void {
      pending = [];
      pendingLength = 0;
    },

    pendingLength: () => pendingLength,
  };
}
