import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

function maximumObserved(previous, value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.max(previous ?? 0, value) : previous;
}

export async function summarizePerformance(directory, since = 0) {
  const files = (await readdir(directory)).filter(name => /^performance(?:\.[1-7])?\.jsonl$/.test(name));
  const processes = new Map();
  const frontendObservations = new Map();
  const report = { samples: 0, malformedLines: 0, firstTimestampMs: null, lastTimestampMs: null,
    events: {}, markers: [], maxFrontendAgeMs: null, maxHeapUsedBytes: null, maxQueuedChars: null,
    maxTimerLagMs: null, maxSamplingGapMs: null, maxPollingSessions: null, maxSampleDurationMs: null, processes: [] };
  for (const name of files) {
    const lines = createInterface({ input: createReadStream(join(directory, name)), crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { report.malformedLines++; continue; }
      if (!record || record.schemaVersion !== 1 || !Number.isFinite(record.timestampMs) || record.timestampMs < since) continue;
      const at = record.timestampMs;
      report.firstTimestampMs = Math.min(report.firstTimestampMs ?? at, at);
      report.lastTimestampMs = Math.max(report.lastTimestampMs ?? at, at);
      const data = record.data ?? {};
      if (record.kind === "event") {
        if (["websocket", "polling", "resync", "manualMarker"].includes(data.kind)) {
          report.events[data.kind] = (report.events[data.kind] ?? 0) + 1;
          if (data.kind === "manualMarker" && report.markers.length < 100) report.markers.push(at);
        }
        continue;
      }
      if (record.kind !== "sample") continue;
      report.samples++;
      report.maxFrontendAgeMs = maximumObserved(report.maxFrontendAgeMs, data.frontendAgeMs);
      if (data.frontend && Number.isFinite(data.frontendAgeMs) && data.frontendAgeMs >= 0) {
        const key = `${record.bootId}:${record.appPid}`;
        const observations = frontendObservations.get(key) ?? [];
        observations.push({ at, age: data.frontendAgeMs });
        frontendObservations.set(key, observations);
      }
      report.maxHeapUsedBytes = maximumObserved(report.maxHeapUsedBytes, data.frontend?.heapUsedBytes);
      // v2 observes visible time only but retains it across visibility changes.
      // Legacy hidden snapshots may contain browser timer throttling instead.
      if (data.frontend?.timingVersion === 2 || data.frontend?.visibility !== "hidden") {
        report.maxTimerLagMs = maximumObserved(report.maxTimerLagMs, data.frontend?.timerLagMs);
      }
      report.maxSamplingGapMs = maximumObserved(report.maxSamplingGapMs, data.frontend?.samplingGapMs);
      report.maxPollingSessions = maximumObserved(report.maxPollingSessions, data.bridge?.pollingSessions);
      report.maxSampleDurationMs = maximumObserved(report.maxSampleDurationMs, data.sampleDurationMs);
      if (Array.isArray(data.frontend?.terminals)) {
        const queued = data.frontend.terminals.reduce((sum, t) => sum + (t.queuedChars ?? 0) + (t.inFlightChars ?? 0) + (t.hiddenChars ?? 0), 0);
        report.maxQueuedChars = maximumObserved(report.maxQueuedChars, queued);
      }
      for (const p of data.processes ?? []) {
        const key = `${record.bootId}:${p.pid}`;
        let row = processes.get(key);
        if (!row) {
          if (processes.size >= 1024) continue;
          row = { bootId: record.bootId, pid: p.pid, role: p.role, firstAt: at, lastAt: at,
            firstPrivateBytes: p.privateBytes, lastPrivateBytes: p.privateBytes, peakPrivateBytes: p.privateBytes,
            peakResidentBytes: maximumObserved(null, p.residentBytes), peakCpuPercent: maximumObserved(null, p.cpuPercent) };
          processes.set(key, row);
        }
        if (at < row.firstAt) { row.firstAt = at; row.firstPrivateBytes = p.privateBytes; }
        if (at >= row.lastAt) { row.lastAt = at; row.lastPrivateBytes = p.privateBytes; }
        if (p.privateBytes != null) row.peakPrivateBytes = Math.max(row.peakPrivateBytes ?? 0, p.privateBytes);
        row.peakResidentBytes = maximumObserved(row.peakResidentBytes, p.residentBytes);
        row.peakCpuPercent = maximumObserved(row.peakCpuPercent, p.cpuPercent);
      }
    }
  }
  report.markers.sort((a, b) => a - b);
  // Both collectors run every 15s, with independent phases. A raw age of 0.7s
  // versus 14.7s alone says nothing about responsiveness. Compare actual update
  // intervals, retaining age as a lower bound so a stalled reporter still fails.
  report.maxFrontendUpdateIntervalMs = null;
  for (const observations of frontendObservations.values()) {
    if (observations.length < 2) continue;
    observations.sort((a, b) => a.at - b.at);
    let previousReportAt = observations[0].at - observations[0].age;
    for (const observation of observations) {
      const reportAt = observation.at - observation.age;
      report.maxFrontendUpdateIntervalMs = Math.max(report.maxFrontendUpdateIntervalMs ?? 0,
        observation.age, reportAt - previousReportAt);
      previousReportAt = Math.max(previousReportAt, reportAt);
    }
  }
  report.processes = [...processes.values()].sort((a, b) => (b.peakPrivateBytes ?? b.peakResidentBytes) - (a.peakPrivateBytes ?? a.peakResidentBytes));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const directory = args[args.indexOf("--dir") + 1];
  if (!args.includes("--dir") || !directory) throw new Error("Usage: node scripts/summarize-performance.mjs --dir <performance directory>");
  console.log(JSON.stringify(await summarizePerformance(directory), null, 2));
}
