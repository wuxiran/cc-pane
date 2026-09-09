import { invokeIfTauri, isTauriRuntime } from "./runtime";
import { invokeOrApi } from "./apiClient";
import { collectTerminalPerformanceMetrics } from "./performanceMetrics";

interface FrontendPerformanceSnapshot {
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  timerLagMs: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  longTaskSupported: boolean;
  playingVideos: number;
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
  let longTaskCount = 0;
  let longTaskMax = 0;
  let inFlight = false;
  let stopped = false;
  let reportedError = false;
  const observer = createLongTaskObserver((duration) => {
    longTaskCount += 1; longTaskMax = Math.max(longTaskMax, duration);
  });
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, Math.max(0, now - lastTick - 1000));
    lastTick = now;
  }, 1000);
  const report = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
    const memory = (performance as HeapPerformance).memory;
    const snapshot: FrontendPerformanceSnapshot = { ...collectTerminalPerformanceMetrics(), heapUsedBytes: memory?.usedJSHeapSize ?? null,
      heapTotalBytes: memory?.totalJSHeapSize ?? null, timerLagMs: Math.min(lag, 86_400_000),
      longTaskCount, longTaskMaxMs: Math.min(longTaskMax, 86_400_000), visibility: document.visibilityState === "visible" ? "visible" : "hidden",
      longTaskSupported: observer !== null, playingVideos: [...document.querySelectorAll("video")].filter(v => !v.paused).length };
    lag = 0; longTaskCount = 0; longTaskMax = 0;
      await invokeIfTauri("record_performance_snapshot", { snapshot });
      reportedError = false;
    } catch (error) {
      if (!reportedError && !stopped) console.warn("Performance snapshot could not be recorded", error);
      reportedError = true;
    } finally { inFlight = false; }
  };
  const reporter = setInterval(() => { void report(); }, 15_000);
  void report();
  return () => { stopped = true; clearInterval(timer); clearInterval(reporter); observer?.disconnect(); };
}

function createLongTaskObserver(onDuration: (duration: number) => void): PerformanceObserver | null {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return null;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onDuration(entry.duration);
  });
  try { observer.observe({ entryTypes: ["longtask"] }); return observer; }
  catch { observer.disconnect(); return null; } // Unsupported host: other metrics remain available.
}
