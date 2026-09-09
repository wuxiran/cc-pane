import type { TerminalRecoverySnapshot } from "@/types";
import { detectAlternateBufferTransitions } from "./terminalBufferMode";

/** The backend mode describes the END of delta; infer its START from its first transition. */
async function initialBufferMode(snapshot: TerminalRecoverySnapshot, canWrite?: () => boolean) {
  const modes = /\x1b\[\?(\d+(?:;\d+)*)(h|l)/g;
  let lastYield = performance.now();
  for (let match = modes.exec(snapshot.delta); match; match = modes.exec(snapshot.delta)) {
    if (canWrite && !canWrite()) throw new Error("Terminal replay cancelled");
    const first = detectAlternateBufferTransitions(match[0])[0];
    if (first) {
      return first.action === "exit" ? "alternate" : "normal";
    }
    if (performance.now() - lastYield >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  // A bounded raw ring can evict every DECSET/DECRST while its mode metadata survives.
  return snapshot.bufferMode;
}

/** Seed raw replay only. Serialized photos already carry the frontend's chosen buffer state. */
export async function restoreReplayBufferMode(
  snapshot: TerminalRecoverySnapshot,
  term: { buffer: { active: { type: "normal" | "alternate" } } },
  writeData: (data: string) => Promise<void>,
  canWrite?: () => boolean,
): Promise<void> {
  if (snapshot.checkpoint) return;
  const mode = await initialBufferMode(snapshot, canWrite);
  if (canWrite && !canWrite()) throw new Error("Terminal replay cancelled");
  if (term.buffer.active.type !== mode) {
    // Use the raw renderer so an explicit per-CLI strip override still takes precedence.
    await writeData(mode === "alternate" ? "\x1b[?1049h" : "\x1b[?1049l");
    if (canWrite && !canWrite()) throw new Error("Terminal replay cancelled");
  }
}
