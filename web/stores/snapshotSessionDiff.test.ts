// 杀决策后置的状态机测试（补账2 + P3 观察链修复）。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  PENDING_KILL_TTL_MS,
  SNAPSHOT_APPLY_KILL_CAP,
  abandonSnapshotKillCandidates,
  beginSnapshotKillCandidates,
  diffSnapshotSessionIds,
  finalizeSnapshotWouldKill,
  performSnapshotApplyKills,
  resetSnapshotKillState,
} from "./snapshotSessionDiff";

// begin/finalize 带 isTauriRuntime 门控（web 端是残缺视图，不参与杀决策）。
// 状态机测试在「桌面端」语境下跑；门控自身有专门用例在下面翻转这个 mock。
const runtimeMock = vi.hoisted(() => ({ isTauri: true }));
vi.mock("@/services/runtime", () => ({
  isTauriRuntime: () => runtimeMock.isTauri,
}));

beforeEach(() => {
  runtimeMock.isTauri = true;
  resetSnapshotKillState();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("**悬挂候选 TTL**：超时的死候选被丢弃、本轮正常登记（区别于 in-flight skip）", () => {
    const t0 = 1_000_000;
    beginSnapshotKillCandidates(new Set(["dangling"]), new Set(), t0);
    // 超过 TTL 后再 begin：不是「上一轮还在跑」，是没人 finalize 的死候选
    beginSnapshotKillCandidates(new Set(["fresh"]), new Set(), t0 + PENDING_KILL_TTL_MS + 1);
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual(["fresh"]);
  });

  it("abandon：候选作废且不产生任何杀集判定", () => {
    beginSnapshotKillCandidates(new Set(["s1"]), new Set());
    abandonSnapshotKillCandidates("backend-unreachable");
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual([]);
  });

  it("**web 门控**：非 Tauri 运行时 begin 不登记、finalize 恒空", () => {
    runtimeMock.isTauri = false;
    beginSnapshotKillCandidates(new Set(["s1"]), new Set());
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual([]);
    // 切回桌面语境：之前没有任何残留候选
    runtimeMock.isTauri = true;
    expect(finalizeSnapshotWouldKill(new Set(), new Set())).toEqual([]);
  });
});

describe("performSnapshotApplyKills（真杀执行器）", () => {
  it("开关关闭（默认）恒零杀——与开闸前行为完全一致", async () => {
    const killSession = vi.fn(async () => {});
    const killed = await performSnapshotApplyKills(["s1", "s2"], {
      enabled: false,
      killSession,
    });
    expect(killed).toBe(0);
    expect(killSession).not.toHaveBeenCalled();
  });

  it("开关开启：逐个以 orphan-reclaim 杀，单个失败不中断", async () => {
    const killSession = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("boom"));
    const killed = await performSnapshotApplyKills(["s1", "s2"], {
      enabled: true,
      killSession,
    });
    expect(killed).toBe(1);
    expect(killSession).toHaveBeenCalledWith("s1", "orphan-reclaim");
    expect(killSession).toHaveBeenCalledWith("s2", "orphan-reclaim");
  });

  it("每轮上限：超过 cap 的目标留给下一轮（差集异常大 = 判定可疑）", async () => {
    const killSession = vi.fn(async () => {});
    const targets = Array.from({ length: SNAPSHOT_APPLY_KILL_CAP + 5 }, (_, i) => `s${i}`);
    const killed = await performSnapshotApplyKills(targets, {
      enabled: true,
      killSession,
    });
    expect(killed).toBe(SNAPSHOT_APPLY_KILL_CAP);
    expect(killSession).toHaveBeenCalledTimes(SNAPSHOT_APPLY_KILL_CAP);
  });
});
