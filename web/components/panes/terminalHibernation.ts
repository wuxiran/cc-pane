/**
 * 后台休眠容器（docs/71 §3，参照 VS Code SerializeAddon 持久化与 orca hibernation）。
 *
 * 休眠 = `SerializeAddon.serialize()` 把整个缓冲（含全部 scrollback 与颜色）压成
 * VT 字符串 + dispose 活实例；单标签内存从几十 MB（活 cell 网格）降到字符串体量，
 * **历史零丢失**（用户已否决一切裁史方案）。
 *
 * 休眠期间的新输出直接 append（serialize 产物本身就是 VT 流，与后续经
 * renderTerminalData 的成品 chunk 直接拼接即保序）。超过上限则整体作废
 * （置 overflow），唤醒时改走后端 replay snapshot——比带缺口回放的必然花屏严格更好。
 */

export interface HibernatedTerminalState {
  readonly sessionId: string;
  /** 追加休眠期间到达的**已渲染**（过 renderTerminalData）chunk。 */
  appendRendered(chunk: string): void;
  /** 唤醒时要整体写入新终端的数据；溢出/desync 后返回 `null`（改走 snapshot）。 */
  wakeData(): string | null;
  didOverflow(): boolean;
  /**
   * daemon desync：镜像流中段被整段跳过，休眠容器已带缺口——整体作废，
   * 唤醒改走后端 snapshot（语义同溢出）。
   */
  markDesynced(): void;
  recordExit(exitCode: number): void;
  exitCode(): number | null;
  pendingChars(): number;
}

/** 休眠容器总上限（基底 + 追加）。超过即作废，唤醒走后端 snapshot。 */
export const HIBERNATED_MAX_CHARS = 4 * 1024 * 1024;

interface CreateHibernatedTerminalStateOptions {
  sessionId: string;
  /** serialize() 产物 + 休眠时点的积压，作为回放基底。 */
  base: string;
  maxChars?: number;
  onOverflow?: () => void;
}

export function createHibernatedTerminalState({
  sessionId,
  base,
  maxChars = HIBERNATED_MAX_CHARS,
  onOverflow,
}: CreateHibernatedTerminalStateOptions): HibernatedTerminalState {
  let overflowed = base.length > maxChars;
  let chunks: string[] = overflowed ? [] : [base];
  let totalChars = overflowed ? 0 : base.length;
  let exitCode: number | null = null;
  if (overflowed) onOverflow?.();

  const invalidate = () => {
    // 整体作废并立即释放：带缺口的 VT 流回放必然花屏，留着只占内存。
    if (overflowed) return;
    overflowed = true;
    chunks = [];
    totalChars = 0;
    onOverflow?.();
  };

  return {
    sessionId,

    appendRendered(chunk: string): void {
      if (overflowed || !chunk) return;
      if (totalChars + chunk.length > maxChars) {
        invalidate();
        return;
      }
      chunks.push(chunk);
      totalChars += chunk.length;
    },

    markDesynced: invalidate,

    wakeData(): string | null {
      if (overflowed) return null;
      return chunks.join("");
    },

    didOverflow: () => overflowed,

    recordExit(code: number): void {
      exitCode = code;
    },

    exitCode: () => exitCode,

    pendingChars: () => totalChars,
  };
}
