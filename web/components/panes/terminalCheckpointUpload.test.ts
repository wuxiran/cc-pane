// M3b-2：拍照上传的守卫（无锚点 skip / 409 分流 / 去抖 / capability 关断）。
// M3b-2 阶段 epoch 只能经 reanchorSeq 手动喂入（恢复读在 M3b-3）——测试用它激活。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/terminalCheckpoint", () => ({
  uploadCheckpoint: vi.fn(),
}));

import { uploadCheckpoint } from "@/services/terminalCheckpoint";
import {
  _resetCheckpointUploadStateForTest,
  CHECKPOINT_UPLOAD_DEBOUNCE_MS,
  captureAndUploadCheckpoint,
  type CheckpointTerminal,
} from "./terminalCheckpointUpload";
import {
  _resetSeqTrackersForTest,
  anchorCandidate,
  reanchorSeq,
} from "./terminalOutputSeqTracker";

const uploadMock = vi.mocked(uploadCheckpoint);

function fakeTerm(type: "normal" | "alternate" = "normal"): CheckpointTerminal {
  return { cols: 80, rows: 24, buffer: { active: { type } } };
}

const serializeAddon = { serialize: vi.fn(() => "PHOTO") };

beforeEach(() => {
  vi.clearAllMocks();
  _resetSeqTrackersForTest();
  _resetCheckpointUploadStateForTest();
});

describe("captureAndUploadCheckpoint", () => {
  it("无锚点候选（M3b-2 常态：epoch 未接通）→ skip 且不 serialize、不上传", async () => {
    const result = await captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, {
      reason: "test",
    });

    expect(result).toBe("skipped-no-anchor");
    expect(serializeAddon.serialize).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("无 xterm（休眠中）→ skip（daemon 周期重发兜底）", async () => {
    reanchorSeq("s1", 100, 7);
    const result = await captureAndUploadCheckpoint("s1", null, serializeAddon, {
      reason: "test",
    });

    expect(result).toBe("skipped-no-terminal");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("成功：payload 带锚点/epoch/尺寸/bufferMode，返回 uploaded", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockResolvedValue({ kind: "accepted", anchorSeq: 100 });

    const result = await captureAndUploadCheckpoint("s1", fakeTerm("alternate"), serializeAddon, {
      reason: "test",
      nowMs: 1_000,
    });

    expect(result).toBe("uploaded");
    expect(uploadMock).toHaveBeenCalledWith("s1", {
      checkpointEpoch: 7,
      anchorSeq: 100,
      snapshotAnsi: "PHOTO",
      bufferMode: "alternate",
      cols: 80,
      rows: 24,
      checkpointedAtMs: 1_000,
    });
  });

  it("snapshotAnsi 已在手（休眠路径）时不再二次 serialize", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockResolvedValue({ kind: "accepted", anchorSeq: 100 });

    await captureAndUploadCheckpoint("s1", fakeTerm(), null, {
      reason: "hibernate",
      snapshotAnsi: "PRESET",
    });

    expect(serializeAddon.serialize).not.toHaveBeenCalled();
    expect(uploadMock.mock.calls[0][1].snapshotAnsi).toBe("PRESET");
  });

  it("409 STALE 无害：debug 即可，锚点记账不作废", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockResolvedValue({ kind: "rejectedStaleAnchor" });

    const result = await captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, {
      reason: "test",
    });

    expect(result).toBe("rejected");
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 100, checkpointEpoch: 7 });
  });

  it("409 EPOCH_MISMATCH：本端 seq 记账整体作废（禁拍直到 reanchor）", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockResolvedValue({ kind: "rejectedEpochMismatch" });

    const result = await captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, {
      reason: "test",
    });

    expect(result).toBe("rejected");
    expect(anchorCandidate("s1")).toBeNull();
  });

  it("去抖 ≥60s：窗口内第二次触发直接 skip，不重复上传", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockResolvedValue({ kind: "accepted", anchorSeq: 100 });

    await captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, {
      reason: "first",
      nowMs: 1_000,
    });
    const second = await captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, {
      reason: "second",
      nowMs: 1_000 + CHECKPOINT_UPLOAD_DEBOUNCE_MS - 1,
    });
    const third = await captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, {
      reason: "third",
      nowMs: 1_000 + CHECKPOINT_UPLOAD_DEBOUNCE_MS,
    });

    expect(second).toBe("skipped-debounce");
    expect(third).toBe("uploaded");
    expect(uploadMock).toHaveBeenCalledTimes(2);
  });

  it("capability 关断（uploadCheckpoint 返回 null）→ skipped-capability", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockResolvedValue(null);

    await expect(
      captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, { reason: "test" }),
    ).resolves.toBe("skipped-capability");
  });

  it("上传异常不外抛（fire-and-forget 安全）", async () => {
    reanchorSeq("s1", 100, 7);
    uploadMock.mockRejectedValue(new Error("boom"));

    await expect(
      captureAndUploadCheckpoint("s1", fakeTerm(), serializeAddon, { reason: "test" }),
    ).resolves.toBe("failed");
  });
});
