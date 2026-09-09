import { getTerminalOutputSchedulerStats } from "./terminalOutputScheduler";

export interface TerminalPerformanceMetric {
  sessionId: string | null;
  visible: boolean;
  renderer: "dom" | "webgl" | "unknown";
  queuedChars: number;
  inFlightChars: number;
  queuedWrites: number;
  receivedChars: number;
  writeCalls: number;
  failedWrites: number;
  oldestWaitMs: number;
  callbackMaxMs: number;
  hiddenChars: number;
  resyncActive: boolean;
  contextLosses: number;
  atlasClears: number;
  scrollbackLines: number;
}

type Source = () => TerminalPerformanceMetric | null;
// Holds getters only while their terminal view is mounted. No output strings,
// write history, or unbounded sequence of samples are retained here.
const sources = new Set<Source>();
const resyncs = new Map<string, { resyncCount: number; resyncChars: number; resyncLastChars: number }>();
export function noteTerminalPerformanceResync(sessionId: string, chars: number): void {
  const previous = resyncs.get(sessionId) ?? { resyncCount: 0, resyncChars: 0, resyncLastChars: 0 };
  resyncs.delete(sessionId);
  resyncs.set(sessionId, { resyncCount: previous.resyncCount + 1, resyncChars: previous.resyncChars + chars, resyncLastChars: chars });
  if (resyncs.size > 128) resyncs.delete(resyncs.keys().next().value!);
}
export function registerTerminalPerformanceSource(source: Source): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}
export function collectTerminalPerformanceMetrics() {
  const terminals: TerminalPerformanceMetric[] = [];
  let terminalCount = 0;
  let failedTerminalSources = 0;
  for (const source of sources) {
    let sample: TerminalPerformanceMetric | null;
    try { sample = source(); } catch { failedTerminalSources += 1; continue; }
    if (!sample) continue;
    terminalCount += 1;
    terminals.push(sample);
  }
  // Keep the largest backlogs when a layout has more than 32 terminal views.
  terminals.sort((a, b) => b.queuedChars + b.inFlightChars + b.hiddenChars - a.queuedChars - a.inFlightChars - a.hiddenChars);
  return { terminalCount, failedTerminalSources, rendererScheduler: getTerminalOutputSchedulerStats(), terminals: terminals.slice(0, 32).map(t => ({ ...t,
    ...(t.sessionId ? resyncs.get(t.sessionId) : undefined) ?? { resyncCount: 0, resyncChars: 0, resyncLastChars: 0 } })) };
}
