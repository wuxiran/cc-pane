// B2-06 双写断言的测试。
//
// 这个断言自己错了比它要抓的 bug 更麻烦：误报会让整个迁移期的日志变成噪声，
// 真漂移淹没在里面；漏报则失去双写的意义。所以三条豁免逐条锁死。
import { describe, it, expect } from "vitest";
import { detectVisibilityDrift, type VisibilitySnapshot } from "./visibilityDriftAssert";

function snap(overrides: Partial<VisibilitySnapshot> = {}): VisibilitySnapshot {
  return {
    legacyRenderVisible: true,
    legacyActive: true,
    storeVisibility: "active",
    storeAnyVisible: true,
    storeViewCount: 1,
    ...overrides,
  };
}

describe("一致时不报", () => {
  it("两条路都说可见且活跃", () => {
    expect(detectVisibilityDrift(snap())).toEqual([]);
  });

  it("两条路都说隐藏", () => {
    expect(detectVisibilityDrift(snap({
      legacyRenderVisible: false,
      legacyActive: false,
      storeVisibility: "hidden",
      storeAnyVisible: false,
    }))).toEqual([]);
  });

  it("可见但无焦点：legacy active=false ↔ store visible", () => {
    expect(detectVisibilityDrift(snap({
      legacyActive: false,
      storeVisibility: "visible",
    }))).toEqual([]);
  });
});

describe("真漂移要报", () => {
  it("旧路说可见、store 说隐藏", () => {
    const drifts = detectVisibilityDrift(snap({
      legacyRenderVisible: true,
      legacyActive: false,
      storeVisibility: "hidden",
      storeAnyVisible: false,
    }));
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: "single-view", legacy: true, store: false });
  });

  it("焦点态不一致单独报一项", () => {
    const drifts = detectVisibilityDrift(snap({
      legacyActive: false,
      storeVisibility: "active",
    }));
    expect(drifts.map((d) => d.kind)).toEqual(["active"]);
  });

  it("两项同时漂移则报两项", () => {
    const drifts = detectVisibilityDrift(snap({
      legacyRenderVisible: false,
      legacyActive: false,
      storeVisibility: "active",
    }));
    expect(drifts.map((d) => d.kind).sort()).toEqual(["active", "single-view"]);
  });
});

describe("豁免：这些「不一致」本来就该发生，报了就是噪声", () => {
  it("store 里还没有本视图条目（首帧 / 卸载中 / dev 双挂载窗口）", () => {
    expect(detectVisibilityDrift(snap({
      storeVisibility: undefined,
      legacyRenderVisible: true,
      legacyActive: true,
    }))).toEqual([]);
  });

  it("多路视图时聚合与单视图不同不算漂移（比的是单视图，不是聚合）", () => {
    // 主视图隐藏、镜像可见：聚合 true，单视图 hidden——两者都对
    const drifts = detectVisibilityDrift(snap({
      legacyRenderVisible: false,
      legacyActive: false,
      storeVisibility: "hidden",
      storeAnyVisible: true,
      storeViewCount: 2,
    }));
    expect(drifts).toEqual([]);
  });
});
