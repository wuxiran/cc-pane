// B2-11 注意标记测试。
import { describe, it, expect, beforeEach } from "vitest";
import { useTabAttentionStore } from "./useTabAttentionStore";

beforeEach(() => {
  useTabAttentionStore.setState({ entries: {} });
});

describe("注意标记", () => {
  it("标记后可查", () => {
    useTabAttentionStore.getState().markAttention("t1", "completed");
    expect(useTabAttentionStore.getState().hasAttention("t1")).toBe(true);
  });

  it("用户看到后清除", () => {
    const store = useTabAttentionStore.getState();
    store.markAttention("t1", "completed");
    store.clearAttention("t1");
    expect(useTabAttentionStore.getState().hasAttention("t1")).toBe(false);
  });

  it("**高优先级不被低优先级覆盖**：出错后又完成，红点仍是出错", () => {
    const store = useTabAttentionStore.getState();
    store.markAttention("t1", "error");
    store.markAttention("t1", "completed");
    expect(useTabAttentionStore.getState().getAttention("t1")?.reason).toBe("error");
  });

  it("低优先级可被高优先级升级", () => {
    const store = useTabAttentionStore.getState();
    store.markAttention("t1", "completed");
    store.markAttention("t1", "error");
    expect(useTabAttentionStore.getState().getAttention("t1")?.reason).toBe("error");
  });

  it("同 reason 重复标记不写状态（防高频刷新）", () => {
    const store = useTabAttentionStore.getState();
    store.markAttention("t1", "waiting-input");
    const snapshot = useTabAttentionStore.getState().entries;
    store.markAttention("t1", "waiting-input");
    expect(useTabAttentionStore.getState().entries).toBe(snapshot);
  });

  it("clearAttention 幂等", () => {
    const snapshot = useTabAttentionStore.getState().entries;
    useTabAttentionStore.getState().clearAttention("nobody");
    expect(useTabAttentionStore.getState().entries).toBe(snapshot);
  });
});
