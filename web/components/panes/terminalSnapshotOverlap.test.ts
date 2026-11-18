import { describe, expect, it } from "vitest";
import { createResyncGateBacklog, dropOutputCoveredBySnapshot } from "./terminalSnapshotOverlap";

describe("dropOutputCoveredBySnapshot", () => {
  it("drops chunks the snapshot already contains and keeps what came after", () => {
    const chunks = [
      { data: "aaaa", endSeq: 104 },
      { data: "bbbb", endSeq: 108 },
      { data: "cccc", endSeq: 112 },
    ];
    expect(dropOutputCoveredBySnapshot(chunks, 108)).toEqual([{ data: "cccc", endSeq: 112 }]);
  });

  it("trims the overlapping head of a batch that straddles the snapshot boundary", () => {
    // 一批 = 两个后端 chunk 合并：[100,104) + [104,108)，快照覆盖到 104。
    expect(dropOutputCoveredBySnapshot([{ data: "aaaabbbb", endSeq: 108 }], 104)).toEqual([
      { data: "bbbb", endSeq: 108 },
    ]);
  });

  it("counts UTF-8 bytes, not string length, when trimming", () => {
    // 「中文」6 字节 + "ok" 2 字节：seq 跨度 8，快照覆盖前 6 字节。
    expect(dropOutputCoveredBySnapshot([{ data: "中文ok", endSeq: 208 }], 206)).toEqual([
      { data: "ok", endSeq: 208 },
    ]);
  });

  it("keeps everything when the first chunk starts at or after the boundary", () => {
    const chunks = [{ data: "abcd", endSeq: 108 }, { data: "efgh", endSeq: 112 }];
    expect(dropOutputCoveredBySnapshot(chunks, 104)).toEqual(chunks);
    expect(dropOutputCoveredBySnapshot(chunks, 90)).toEqual(chunks);
  });

  it("stops judging after the boundary and never drops chunks without a seq", () => {
    const chunks = [
      { data: "old", endSeq: 100 },
      { data: "noseq" },
      { data: "new", endSeq: 120 },
      { data: "after-reset", endSeq: 5 },
    ];
    expect(dropOutputCoveredBySnapshot(chunks, 110)).toEqual([
      { data: "noseq" },
      { data: "new", endSeq: 120 },
      { data: "after-reset", endSeq: 5 },
    ]);
  });

  it("returns everything when there is no usable floor", () => {
    const chunks = [{ data: "a", endSeq: 1 }];
    expect(dropOutputCoveredBySnapshot(chunks, null)).toEqual(chunks);
  });
});

describe("createResyncGateBacklog", () => {
  it("returns chunks in arrival order and empties itself", () => {
    const backlog = createResyncGateBacklog();
    backlog.push("a", 1);
    backlog.push("b", 2);
    expect(backlog.take()).toEqual({ chunks: [{ data: "a", endSeq: 1 }, { data: "b", endSeq: 2 }], overflowed: false });
    expect(backlog.take()).toEqual({ chunks: [], overflowed: false });
  });

  it("gives up the whole backlog once it overflows", () => {
    const backlog = createResyncGateBacklog(4);
    backlog.push("abc", 3);
    backlog.push("de", 5);
    backlog.push("f", 6);
    expect(backlog.pendingLength()).toBe(0);
    expect(backlog.take()).toEqual({ chunks: [], overflowed: true });
    backlog.push("g", 7);
    expect(backlog.take()).toEqual({ chunks: [{ data: "g", endSeq: 7 }], overflowed: false });
  });

  it("reset discards content and the overflow flag", () => {
    const backlog = createResyncGateBacklog(2);
    backlog.push("abc", 3);
    backlog.reset();
    expect(backlog.take()).toEqual({ chunks: [], overflowed: false });
  });
});
