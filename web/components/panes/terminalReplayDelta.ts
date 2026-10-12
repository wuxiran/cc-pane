import type { TerminalRecoverySnapshot } from "@/types";
import { writeTerminalReplay } from "./terminalReplayChunks";
import { restoreTerminalReplayGeometry, type ReplayGeometryTerminal } from "./terminalReplayGeometry";

type DeltaSnapshot = Pick<TerminalRecoverySnapshot, "delta" | "deltaGeometry" | "deltaResizes">;

/**
 * 按 PTY 当时的尺寸重放 raw delta：起点先调到 deltaGeometry，遇到 resize 点再调。
 * TUI（Ink 等）用「光标上移 N 行 + 擦行」差量重绘，N 依赖列宽——宽度不对时
 * 旧帧擦不干净，整段残帧落进 scrollback。旧后端不带尺寸时回落按当前尺寸整写。
 *
 * 无窗口内 resize 时直接返回单次 writeTerminalReplay 的 promise（不包 async），
 * 与旧路径 await 深度一致。
 */
export function writeTerminalDeltaReplay(
  term: ReplayGeometryTerminal,
  snapshot: DeltaSnapshot,
  writeData: (data: string) => Promise<void>,
  canWrite?: () => boolean,
): Promise<void> {
  const { delta } = snapshot;
  if (snapshot.deltaGeometry) restoreTerminalReplayGeometry(term, snapshot.deltaGeometry);
  // delta 起点可能切在转义序列中段：只有从 0 开始的首段需要切断头尾。
  const write = (start: number, end: number) =>
    writeTerminalReplay(delta.slice(start, end), writeData, {
      canWrite,
      dropLeadingEscapeTail: start === 0,
    });
  const resizes = snapshot.deltaResizes ?? [];
  if (resizes.length === 0) return write(0, delta.length);
  return (async () => {
    let offset = 0;
    for (const resize of resizes) {
      const end = Math.min(Math.max(0, resize.offset), delta.length);
      if (end > offset) {
        await write(offset, end);
        offset = end;
      }
      restoreTerminalReplayGeometry(term, resize);
    }
    if (offset < delta.length) await write(offset, delta.length);
  })();
}
