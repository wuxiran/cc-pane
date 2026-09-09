import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizePerformance } from "./summarize-performance.mjs";

test("summarizes rotated files by timestamp and keeps restarted processes separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccpanes-performance-"));
  const sample = (bootId, timestampMs, privateBytes) => ({ schemaVersion: 1, bootId, timestampMs, kind: "sample", data: {
    frontendAgeMs: 200, frontend: { heapUsedBytes: 50, terminals: [{ queuedChars: 3, inFlightChars: 4, hiddenChars: 5 }] },
    processes: [{ pid: 1, role: "renderer", privateBytes, residentBytes: 10, cpuPercent: 5 }] } });
  try {
    await writeFile(join(dir, "performance.jsonl"), `${JSON.stringify(sample("new", 30, 80))}\n${JSON.stringify(sample("old", 20, 200))}\npartial`);
    await writeFile(join(dir, "performance.1.jsonl"), `${JSON.stringify(sample("old", 10, 100))}\n`);
    const report = await summarizePerformance(dir);
    assert.equal(report.samples, 3); assert.equal(report.malformedLines, 1);
    assert.equal(report.maxQueuedChars, 12); assert.equal(report.firstTimestampMs, 10);
    assert.equal(report.processes.length, 2);
    assert.equal(report.processes[0].firstPrivateBytes, 100);
    assert.equal(report.processes[0].lastPrivateBytes, 200);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
