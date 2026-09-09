import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export async function summarizePerformance(directory, since = 0) {
  const files = (await readdir(directory)).filter(name => /^performance(?:\.[1-7])?\.jsonl$/.test(name));
  const processes = new Map();
  const report = { samples: 0, malformedLines: 0, firstTimestampMs: null, lastTimestampMs: null,
    events: {}, markers: [], maxFrontendAgeMs: 0, maxHeapUsedBytes: 0, maxQueuedChars: 0,
    maxTimerLagMs: 0, maxPollingSessions: 0, maxSampleDurationMs: 0, processes: [] };
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
      report.maxFrontendAgeMs = Math.max(report.maxFrontendAgeMs, data.frontendAgeMs ?? 0);
      report.maxHeapUsedBytes = Math.max(report.maxHeapUsedBytes, data.frontend?.heapUsedBytes ?? 0);
      report.maxTimerLagMs = Math.max(report.maxTimerLagMs, data.frontend?.timerLagMs ?? 0);
      report.maxPollingSessions = Math.max(report.maxPollingSessions, data.bridge?.pollingSessions ?? 0);
      report.maxSampleDurationMs = Math.max(report.maxSampleDurationMs, data.sampleDurationMs ?? 0);
      const queued = (data.frontend?.terminals ?? []).reduce((sum, t) => sum + (t.queuedChars ?? 0) + (t.inFlightChars ?? 0) + (t.hiddenChars ?? 0), 0);
      report.maxQueuedChars = Math.max(report.maxQueuedChars, queued);
      for (const p of data.processes ?? []) {
        const key = `${record.bootId}:${p.pid}`;
        let row = processes.get(key);
        if (!row) {
          if (processes.size >= 1024) continue;
          row = { bootId: record.bootId, pid: p.pid, role: p.role, firstAt: at, lastAt: at,
            firstPrivateBytes: p.privateBytes, lastPrivateBytes: p.privateBytes, peakPrivateBytes: p.privateBytes,
            peakResidentBytes: p.residentBytes ?? 0, peakCpuPercent: p.cpuPercent ?? 0 };
          processes.set(key, row);
        }
        if (at < row.firstAt) { row.firstAt = at; row.firstPrivateBytes = p.privateBytes; }
        if (at >= row.lastAt) { row.lastAt = at; row.lastPrivateBytes = p.privateBytes; }
        if (p.privateBytes != null) row.peakPrivateBytes = Math.max(row.peakPrivateBytes ?? 0, p.privateBytes);
        row.peakResidentBytes = Math.max(row.peakResidentBytes, p.residentBytes ?? 0);
        row.peakCpuPercent = Math.max(row.peakCpuPercent, p.cpuPercent ?? 0);
      }
    }
  }
  report.markers.sort((a, b) => a - b);
  report.processes = [...processes.values()].sort((a, b) => (b.peakPrivateBytes ?? b.peakResidentBytes) - (a.peakPrivateBytes ?? a.peakResidentBytes));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const directory = args[args.indexOf("--dir") + 1];
  if (!args.includes("--dir") || !directory) throw new Error("Usage: node scripts/summarize-performance.mjs --dir <performance directory>");
  console.log(JSON.stringify(await summarizePerformance(directory), null, 2));
}
