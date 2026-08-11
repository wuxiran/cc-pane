/**
 * 后台（不可见）终端的写入积压缓冲。
 *
 * 背景：非活动标签页只是 `display: none`，TerminalView 仍保持挂载、output 回调仍全速
 * 把数据喂给 xterm。N 个后台会话同时刷屏 = N 份 parser + DOM renderer 抢主线程
 * （实测本机同时挂 18 个会话，见 docs/71 §3、docs/73 §4）。
 *
 * 不可见期间最多保留固定长度的完整 chunk 前缀；首次越界后冻结缓冲并丢弃后续隐藏
 * 输出，恢复时显示截断提示。不能在这里把溢出块 fire-and-forget 给 xterm：那只会把
 * 无界积压转移到 Promise/xterm 写队列，既不限制总内存，也会重新触发后台解析。
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
  /**
   * 是否已溢出（积压带缺口）。可见性回归的消费方应据此改走 snapshot 重放
   * 而不是 drain——带缺口的积压 flush 出来必然花屏。drain/reset 会清除该标志。
   */
  didOverflow(): boolean;
  pendingLength(): number;
  /** 诊断当前常驻字符串槽数量，防止微小 chunk 退化为无界对象数组。 */
  pendingChunkCount(): number;
}

/** 隐藏输出保留上限（字符数）。 */
const DEFAULT_MAX_PENDING_CHARS = 512 * 1024;
const HIDDEN_OUTPUT_TRUNCATED_NOTICE =
  "\x18\r\n\x1b[33m[CC-Panes] Hidden terminal output was truncated to protect memory.\x1b[0m\r\n";
const MAX_OPEN_CHUNKS = 128;
const TARGET_BLOCK_CHARS = 8 * 1024;
const MAX_SEALED_BLOCKS = 64;

interface CreateTerminalHiddenWriteBufferOptions {
  /** 当前终端是否可见。可见时数据直通，不进积压。 */
  isVisible: () => boolean;
  maxPendingChars?: number;
  /** 首次超过上限时调用；参数是触发截断的 chunk 长度。 */
  onOverflowDrop?: (droppedChunkLength: number) => void;
}

export function createTerminalHiddenWriteBuffer({
  isVisible,
  maxPendingChars = DEFAULT_MAX_PENDING_CHARS,
  onOverflowDrop,
}: CreateTerminalHiddenWriteBufferOptions): TerminalHiddenWriteBuffer {
  let sealedBlocks: string[] = [];
  let openChunks: string[] = [];
  let openLength = 0;
  let pendingLength = 0;
  let overflowed = false;

  const sealOpenChunks = (): void => {
    if (openChunks.length === 0) return;
    sealedBlocks.push(openChunks.join(""));
    openChunks = [];
    openLength = 0;

    if (sealedBlocks.length >= MAX_SEALED_BLOCKS) {
      sealedBlocks = [sealedBlocks.join("")];
    }
  };

  const takeAll = (): string | null => {
    if (pendingLength === 0 && !overflowed) return null;
    const merged = sealedBlocks.join("")
      + openChunks.join("")
      + (overflowed ? HIDDEN_OUTPUT_TRUNCATED_NOTICE : "");
    sealedBlocks = [];
    openChunks = [];
    openLength = 0;
    pendingLength = 0;
    overflowed = false;
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

      if (overflowed) return null;
      if (pendingLength + data.length > maxPendingChars) {
        overflowed = true;
        onOverflowDrop?.(data.length);
        return null;
      }

      openChunks.push(data);
      openLength += data.length;
      pendingLength += data.length;
      if (openChunks.length >= MAX_OPEN_CHUNKS || openLength >= TARGET_BLOCK_CHARS) {
        sealOpenChunks();
      }
      return null;
    },

    drain: takeAll,

    reset(): void {
      sealedBlocks = [];
      openChunks = [];
      openLength = 0;
      pendingLength = 0;
      overflowed = false;
    },

    didOverflow: () => overflowed,

    pendingLength: () => pendingLength,

    pendingChunkCount: () => sealedBlocks.length + openChunks.length,
  };
}
