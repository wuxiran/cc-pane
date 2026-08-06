// 杀决策后置的状态机测试（补账2）。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  beginSnapshotKillCandidates,
  diffSnapshotSessionIds,
  finalizeSnapshotWouldKill,
  resetSnapshotKillState,
} from "./snapshotSessionDiff";

beforeEach(() => {
  resetSnapshotKillState();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("差集", () => {
  it("旧引用减新引用", () => {
    expect(diffSnapshotSessionIds(new Set(["a", "b"]), new Set(["b"]))).toEqual(["a"]);
  });
});

describe("杀决策后置状态机", () => {
  it("settle 复核：被收养回来的（当前树引用/后端仍活）从杀集扣除", () => {
    beginSnapshotKillCandidates(new Set(["s1", "s2", "s3"]), new Set());
    const final = finalizeSnapshotWouldKill(new Set(["s1"]), new Set(["s2"]));
    expect(final).toEqual(["s3"]);
  });

  it("**in-flight 锁**：上一轮未 settle 时本轮跳过登记（叠加必误判）", () => {
    beginSnapshotKillCandidates(new Set(["s1"]), new Set());
    beginSnapshotKillCandidates(new Set(["s2"]), new Set());  // 应被跳过
    const final = finalizeSnapshotWouldKill(new Set(), new Set());
    expect(final).toEqual(["s1"]);
    // s2 那轮被丢弃，锁已释放
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual([]);
  });

  it("finalize 清空状态：连调两次第二次为空（幂等）", () => {
    beginSnapshotKillCandidates(new Set(["s1"]), new Set());
    finalizeSnapshotWouldKill(new Set(), new Set());
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual([]);
  });

  it("无候选不登记（空差集不占锁）", () => {
    beginSnapshotKillCandidates(new Set(["s1"]), new Set(["s1"]));
    beginSnapshotKillCandidates(new Set(["s2"]), new Set());  // 锁未被占，应正常登记
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual(["s2"]);
  });
});
