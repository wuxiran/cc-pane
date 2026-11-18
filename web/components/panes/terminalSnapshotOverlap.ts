// 快照回放与实时流的对账。
//
// 恢复快照带 endSeq（daemon raw 字节空间里它覆盖到哪）。回放期间到达、或订阅前暂存的
// 实时 chunk 里，endSeq 不超过它的部分快照已经包含，再写一遍就是重复：普通文本多出
// 几行，相对光标移动会在错误的行上重画，表现为重叠、残影、错行。
//
// seq 的单位：后端 ReplayBuffer 每 push 一个 chunk 累加 `data.len()`（UTF-8 字节数），
// 下发的字符串就是那个 chunk，所以「chunk 的 UTF-8 字节数」精确等于它占的 seq 跨度，
// 快照 endSeq 也必落在 chunk 边界上（不会切在字符中间）。批量下发会把几个 chunk 合并，
// 因此边界可能落在一个下发批的中段——那一批要按字节裁掉前面的重叠段。

export interface SeqChunk {
  data: string;
  endSeq?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 去掉 `chunks` 中已被快照（覆盖到 `floorSeq`）包含的部分。
 * `floorSeq` 为 null（恢复失败 / 旧后端无 seq 记账）时原样返回。
 * 不带 endSeq 的 chunk 无法判断，保留。
 */
export function dropOutputCoveredBySnapshot<T extends SeqChunk>(
  chunks: readonly T[],
  floorSeq: number | null,
): T[] {
  if (floorSeq === null) return [...chunks];
  const kept: T[] = [];
  let pastBoundary = false;
  for (const chunk of chunks) {
    if (pastBoundary || chunk.endSeq === undefined) {
      kept.push(chunk);
      continue;
    }
    if (chunk.endSeq <= floorSeq) continue;
    pastBoundary = true;
    const bytes = encoder.encode(chunk.data);
    const overlap = floorSeq - (chunk.endSeq - bytes.length);
    if (overlap <= 0 || overlap >= bytes.length) {
      kept.push(chunk);
    } else {
      kept.push({ ...chunk, data: decoder.decode(bytes.subarray(overlap)) });
    }
  }
  return kept;
}

/** 重同步闸门期的实时输出暂存：存原始数据和 endSeq，不提前过渲染变换。 */
export interface ResyncGateBacklog {
  push(data: string, endSeq?: number): void;
  /** 取出全部并清空。`overflowed` 为真时内容不完整，调用方应再重同步一次。 */
  take(): { chunks: SeqChunk[]; overflowed: boolean };
  reset(): void;
  pendingLength(): number;
}

const DEFAULT_GATE_BACKLOG_CHARS = 512 * 1024;

export function createResyncGateBacklog(maxChars = DEFAULT_GATE_BACKLOG_CHARS): ResyncGateBacklog {
  let chunks: SeqChunk[] = [];
  let length = 0;
  let overflowed = false;
  const clear = () => {
    chunks = [];
    length = 0;
    overflowed = false;
  };
  return {
    push(data, endSeq) {
      if (!data || overflowed) return;
      if (length + data.length > maxChars) {
        // 带缺口的积压写出来必然花屏：整段作废，交给下一轮快照。
        chunks = [];
        length = 0;
        overflowed = true;
        return;
      }
      chunks.push({ data, endSeq });
      length += data.length;
    },
    take() {
      const result = { chunks, overflowed };
      clear();
      return result;
    },
    reset: clear,
    pendingLength: () => length,
  };
}
