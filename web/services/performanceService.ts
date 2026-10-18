import { invokeIfTauri, isTauriRuntime } from "./runtime";
import { invokeOrApi } from "./apiClient";
import { collectTerminalPerformanceMetrics } from "./performanceMetrics";

interface FrontendPerformanceSnapshot {
  timingVersion: 2;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  timerLagMs: number;
  samplingGapMs: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  longTaskSupported: boolean;
  playingVideos: number;
  focused: boolean;
  visibility: "visible" | "hidden";
  terminalCount: number;
  failedTerminalSources: number;
  terminals: ReturnType<typeof collectTerminalPerformanceMetrics>["terminals"];
}

interface RecorderStatus {
  running: boolean;
  directory: string;
  lastWriteAtMs: number;
  droppedEvents: number;
  lastError: string | null;
  sampleIntervalSeconds: number;
  maxTotalBytes: number;
}
interface HeapPerformance extends Performance {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
}

export const performanceService = {
  getStatus: () => invokeIfTauri<RecorderStatus>("get_performance_recorder_status"),
  markIncident: () => invokeIfTauri<void>("mark_performance_incident"),
  async openDirectory(): Promise<void> {
    const status = await performanceService.getStatus();
    if (!status) throw new Error("Performance records are only available in the desktop app");
    await invokeOrApi("open_path_in_explorer", { path: status.directory }, async () => {
      throw new Error("Performance records are only available in the desktop app");
    });
  },
};

/** One recorder per main page; no periodic work in hidden popup/auxiliary pages. */
export function startPerformanceSampling(): () => void {
  if (!isTauriRuntime()) return () => {};
  let lastTick = performance.now();
  let lag = 0;
  let samplingGap = 0;
  let longTaskCount = 0;
  let longTaskMax = 0;
  let inFlight = false;
  let stopped = false;
  let reportedError = false;
  const observer = createLongTaskObserver((duration) => {
    longTaskCount += 1; longTaskMax = Math.max(longTaskMax, duration);
  });
  const tick = () => {
    const now = performance.now();
    const elapsed = now - lastTick;
    // A long observation gap may be sleep, suspension or a real hang. Preserve
    // it separately instead of presenting hours asleep as measured UI latency.
    if (elapsed > 30_000) samplingGap = Math.max(samplingGap, elapsed);
    else lag = Math.max(lag, Math.max(0, elapsed - 1000));
    lastTick = now;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const resetTiming = () => {
    // A hide event may run before the delayed heartbeat after a main-thread
    // stall. Finish only a previously visible interval, never the hidden gap.
    if (timer !== undefined) tick();
    clearInterval(timer);
    timer = undefined;
    lastTick = performance.now();
    // Rebase the clock without erasing visible work observed before hiding.
    // The next report retains those observations even if the window is hidden.
    if (!document.hidden && !stopped) timer = setInterval(tick, 1000);
  };
  resetTiming();
  document.addEventListener("visibilitychange", resetTiming);
  window.addEventListener("pageshow", resetTiming);
  const report = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    let attemptedTiming: { lag: number; gap: number; count: number; maximum: number } | undefined;
    try {
    const memory = (performance as HeapPerformance).memory;
    const { terminals, ...metrics } = collectTerminalPerformanceMetrics();
    // These two fields are local flow diagnostics, not part of the strict Rust DTO.
    const recorderTerminals = terminals.map(({ blocked: _blocked, pendingCallbacks: _pending, ...metric }) => metric);
    const snapshot: FrontendPerformanceSnapshot = { ...metrics, timingVersion: 2, terminals: recorderTerminals, heapUsedBytes: memory?.usedJSHeapSize ?? null,
      heapTotalBytes: memory?.totalJSHeapSize ?? null, timerLagMs: Math.min(lag, 86_400_000),
      samplingGapMs: Math.min(samplingGap, 86_400_000),
      longTaskCount, longTaskMaxMs: Math.min(longTaskMax, 86_400_000), visibility: document.visibilityState === "visible" ? "visible" : "hidden",
      focused: document.hasFocus(), longTaskSupported: observer !== null,
      playingVideos: [...document.querySelectorAll("video")].filter(v => !v.paused).length };
    attemptedTiming = { lag, gap: samplingGap, count: longTaskCount, maximum: longTaskMax };
    lag = 0; samplingGap = 0; longTaskCount = 0; longTaskMax = 0;
      await invokeIfTauri("record_performance_snapshot", { snapshot });
      reportedError = false;
    } catch (error) {
      if (attemptedTiming) {
        lag = Math.max(lag, attemptedTiming.lag);
        samplingGap = Math.max(samplingGap, attemptedTiming.gap);
        longTaskCount += attemptedTiming.count;
        longTaskMax = Math.max(longTaskMax, attemptedTiming.maximum);
      }
      if (!reportedError && !stopped) console.warn("Performance snapshot could not be recorded", error);
      reportedError = true;
    } finally { inFlight = false; }
  };
  const reporter = setInterval(() => { void report(); }, 15_000);
  void report();
  return () => {
    stopped = true; clearInterval(timer); clearInterval(reporter); observer?.disconnect();
    document.removeEventListener("visibilitychange", resetTiming);
    window.removeEventListener("pageshow", resetTiming);
  };
}

function createLongTaskObserver(onDuration: (duration: number) => void): PerformanceObserver | null {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return null;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onDuration(entry.duration);
  });
  try { observer.observe({ entryTypes: ["longtask"] }); return observer; }
  catch { observer.disconnect(); return null; } // Unsupported host: other metrics remain available.
}
