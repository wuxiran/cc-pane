// seq 跟踪器测试（M3b-2）：锚点只认「已确认写入且无 in-flight」的 raw seq。
import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetSeqTrackersForTest,
  anchorCandidate,
  clearSeqTracker,
  invalidateSeq,
  noteEpoch,
  noteReceived,
  noteWritten,
  reanchorSeq,
} from "./terminalOutputSeqTracker";

beforeEach(() => _resetSeqTrackersForTest());

describe("锚点候选判定", () => {
  it("received == written 且已知 epoch 时给出候选", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 100, checkpointEpoch: 7 });
  });

  it("有 in-flight（received > written）时禁拍——write 队列异步，拍了缺尾", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    noteReceived("s1", 160);
    expect(anchorCandidate("s1")).toBeNull();
    noteWritten("s1", 160);
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 160, checkpointEpoch: 7 });
  });

  it("无 epoch / 无写入记录时禁拍（轮询降级模式天然无 endSeq）", () => {
    expect(anchorCandidate("unknown")).toBeNull();
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    expect(anchorCandidate("s1")).toBeNull(); // 没 epoch
  });
});

describe("失效与重锚", () => {
  it("invalidate 后禁拍，reanchor 恢复", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    invalidateSeq("s1");
    expect(anchorCandidate("s1")).toBeNull();
    reanchorSeq("s1", 500, 7);
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 500, checkpointEpoch: 7 });
  });

  it("seq 非单调视同失效（缺口/会话重建，前端无法自证连续）", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    noteReceived("s1", 80); // 回绕
    expect(anchorCandidate("s1")).toBeNull();
  });

  it("epoch 变化（daemon 重启/会话重建）作废全部 seq 记录", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    noteEpoch("s1", 8);
    expect(anchorCandidate("s1")).toBeNull();
    // 新 epoch 下重新积累
    noteReceived("s1", 10);
    noteWritten("s1", 10);
    expect(anchorCandidate("s1")).toBeNull(); // 仍失效——必须经统一恢复 reanchor
    reanchorSeq("s1", 10, 8);
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 10, checkpointEpoch: 8 });
  });

  it("noteWritten 的重复/迟到确认（多视图各写一遍）是幂等，不触发失效", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100); // 主视图
    noteWritten("s1", 100); // 星标镜像同 chunk 重复确认
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 100, checkpointEpoch: 7 });

    noteReceived("s1", 160);
    noteWritten("s1", 160); // 主视图已到 160
    noteWritten("s1", 100); // 滞后镜像迟到确认旧 chunk
    expect(anchorCandidate("s1")).toEqual({ anchorSeq: 160, checkpointEpoch: 7 });
  });

  it("clearSession 后如新会话（销毁侧卫星态清理）", () => {
    noteEpoch("s1", 7);
    noteReceived("s1", 100);
    noteWritten("s1", 100);
    clearSeqTracker("s1");
    expect(anchorCandidate("s1")).toBeNull();
  });
});
