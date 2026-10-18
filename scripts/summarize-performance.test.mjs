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

test("frontend intervals are independent of sampling phase and retain stalls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccpanes-performance-phase-"));
  const summarize = async ages => {
    await writeFile(join(dir, "performance.jsonl"), ages.map((age, i) => JSON.stringify({
      schemaVersion: 1, bootId: "one", appPid: 1, timestampMs: 30000 + i * 15000,
      kind: "sample", data: { frontendAgeMs: age, frontend: {} },
    })).join("\n"));
    return summarizePerformance(dir);
  };
  try {
    const early = await summarize([700, 700, 700]);
    const late = await summarize([14700, 14700, 14700]);
    assert.equal(early.maxFrontendUpdateIntervalMs, 15000);
    assert.equal(late.maxFrontendUpdateIntervalMs, 15000);
    assert.equal(late.maxFrontendAgeMs, 14700);
    assert.equal((await summarize([700, 15700, 30700])).maxFrontendUpdateIntervalMs, 30700);
    assert.equal((await summarize([700])).maxFrontendUpdateIntervalMs, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("retains unavailable metrics as null and separates hidden lag from observation gaps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccpanes-performance-missing-"));
  try {
    const rows = [
      { visibility: "hidden", timerLagMs: 3_600_000, samplingGapMs: 0 },
      { visibility: "visible", timerLagMs: 25, samplingGapMs: 60_000 },
    ].map((frontend, i) => ({ schemaVersion: 1, bootId: "one", appPid: 1,
      timestampMs: i * 15_000, kind: "sample", data: {
        frontend: { ...frontend, heapUsedBytes: null },
        processes: [{ pid: 1, role: "renderer", privateBytes: null, cpuPercent: null, residentBytes: 1024 }],
      } }));
    await writeFile(join(dir, "performance.jsonl"), rows.map(JSON.stringify).join("\n"));
    const report = await summarizePerformance(dir);
    assert.equal(report.maxHeapUsedBytes, null);
    assert.equal(report.maxTimerLagMs, 25);
    assert.equal(report.maxSamplingGapMs, 60_000);
    assert.equal(report.processes[0].peakPrivateBytes, null);
    assert.equal(report.processes[0].peakCpuPercent, null);
    assert.equal(report.processes[0].peakResidentBytes, 1024);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing frontend stays unavailable and v2 keeps visible lag reported after hiding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccpanes-performance-visibility-"));
  const write = data => writeFile(join(dir, "performance.jsonl"), JSON.stringify({
    schemaVersion: 1, bootId: "one", appPid: 1, timestampMs: 15_000, kind: "sample", data,
  }));
  try {
    await write({ frontend: null, frontendAgeMs: null });
    let report = await summarizePerformance(dir);
    for (const key of ["maxQueuedChars", "maxFrontendAgeMs", "maxHeapUsedBytes", "maxTimerLagMs", "maxSampleDurationMs"]) {
      assert.equal(report[key], null, key);
    }
    await write({ frontend: { timingVersion: 2, visibility: "hidden", timerLagMs: 4000, samplingGapMs: 0 } });
    report = await summarizePerformance(dir);
    assert.equal(report.maxTimerLagMs, 4000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
