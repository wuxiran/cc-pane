import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadCheckpoint } from "@/services/terminalCheckpoint";
import { resyncFromReplaySnapshot } from "./terminalResync";
import { _resetCheckpointUploadStateForTest } from "./terminalCheckpointUpload";
import { _resetSeqTrackersForTest, noteReceived, reanchorSeq } from "./terminalOutputSeqTracker";
import {
  checkpointRecoveredTerminal, registerRecoveryCheckpointSource, unregisterRecoveryCheckpointSource,
} from "./terminalRecoveryCheckpoint";

vi.mock("@/services/terminalCheckpoint", () => ({
  uploadCheckpoint: vi.fn(async () => ({ kind: "accepted", anchorSeq: 100 })),
}));

beforeEach(() => { vi.clearAllMocks(); _resetSeqTrackersForTest(); _resetCheckpointUploadStateForTest(); });

function setup() {
  const term = { cols: 100, rows: 30, buffer: { active: { type: "normal" as const } }, reset: vi.fn() };
  const serializer = { serialize: vi.fn(() => "FINAL STATE") };
  return { term, serializer };
}

describe("checkpoint after recovery", () => {
  it("saves the final parsed state at the recovered sequence instead of the repeated drawing history", async () => {
    const { term, serializer } = setup();
    registerRecoveryCheckpointSource(term, serializer);
    const delta = "\rprogress...".repeat(1000) + "\rFINAL STATE";
    await resyncFromReplaySnapshot({
      term, sessionId: "s1", reason: "test",
      getRecoverySnapshot: async () => ({ checkpoint: null, delta, bufferMode: "normal", endSeq: 100, checkpointEpoch: 7 }),
      writeData: async () => {}, writeCheckpointData: async () => {},
      syncTrackedBufferType: vi.fn(), debugLog: vi.fn(),
    });
    expect(uploadCheckpoint).toHaveBeenCalledWith("s1", expect.objectContaining({
      snapshotAnsi: "FINAL STATE", anchorSeq: 100, checkpointEpoch: 7, cols: 100, rows: 30,
    }));
  });

  it("skips views without a registered primary checkpoint source", () => {
    const { term, serializer } = setup();
    reanchorSeq("s1", 100, 7);
    checkpointRecoveredTerminal(term, "s1");
    expect(serializer.serialize).not.toHaveBeenCalled();
    expect(uploadCheckpoint).not.toHaveBeenCalled();
  });

  it("does not save state whose output is still in flight", () => {
    const { term, serializer } = setup();
    registerRecoveryCheckpointSource(term, serializer);
    reanchorSeq("s1", 100, 7);
    noteReceived("s1", 120);
    checkpointRecoveredTerminal(term, "s1");
    expect(serializer.serialize).not.toHaveBeenCalled();
    expect(uploadCheckpoint).not.toHaveBeenCalled();
  });

  it("does not publish a snapshot after the terminal is disposed", () => {
    const { term, serializer } = setup();
    registerRecoveryCheckpointSource(term, serializer);
    reanchorSeq("s1", 100, 7);
    unregisterRecoveryCheckpointSource(term);
    checkpointRecoveredTerminal(term, "s1");
    expect(uploadCheckpoint).not.toHaveBeenCalled();
  });

  it("rechecks write ownership when a live primary view becomes read-only", () => {
    const { term, serializer } = setup();
    let writable = true;
    registerRecoveryCheckpointSource(term, serializer, () => writable);
    reanchorSeq("s1", 100, 7);
    writable = false;
    checkpointRecoveredTerminal(term, "s1");
    expect(serializer.serialize).not.toHaveBeenCalled();
    expect(uploadCheckpoint).not.toHaveBeenCalled();
    writable = true;
    checkpointRecoveredTerminal(term, "s1");
    expect(uploadCheckpoint).toHaveBeenCalledOnce();
  });
});
