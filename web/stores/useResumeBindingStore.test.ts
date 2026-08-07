import { beforeEach, describe, expect, it } from "vitest";
import {
  RESUME_BINDING_TTL_MS,
  resumeSourcePriority,
  useResumeBindingStore,
} from "./useResumeBindingStore";

beforeEach(() => {
  useResumeBindingStore.setState({ bindings: {} });
});

describe("resumeSourcePriority", () => {
  // 与 cc-panes-core/src/services/resume_identity.rs 的表保持镜像。
  it("镜像后端优先级表", () => {
    expect(resumeSourcePriority("manual")).toBe(40);
    expect(resumeSourcePriority("issued")).toBe(30);
    expect(resumeSourcePriority("osc-title")).toBe(30);
    expect(resumeSourcePriority("rollout-scan")).toBe(10);
    expect(resumeSourcePriority("backfill")).toBe(10);
    expect(resumeSourcePriority("rescue")).toBe(5);
    expect(resumeSourcePriority(undefined)).toBe(30);
  });
});

describe("recordBinding 来源仲裁", () => {
  it("同级来源覆盖（should_replace_source 的 >= 语义），版本单调递增", () => {
    const store = useResumeBindingStore.getState();
    expect(store.recordBinding("pty-1", "resume-a", "issued")).toBe(true);
    expect(store.recordBinding("pty-1", "resume-b", "osc-title")).toBe(true);
    const binding = useResumeBindingStore.getState().getBinding("pty-1");
    expect(binding?.resumeId).toBe("resume-b");
    expect(binding?.version).toBe(2);
  });

  it("低优先级来源不得降级已有绑定", () => {
    const store = useResumeBindingStore.getState();
    store.recordBinding("pty-1", "resume-issued", "issued");
    expect(store.recordBinding("pty-1", "resume-scan", "rollout-scan")).toBe(false);
    expect(useResumeBindingStore.getState().getBinding("pty-1")?.resumeId).toBe(
      "resume-issued",
    );
  });

  it("manual 压过一切，之后 issued 覆盖不动它", () => {
    const store = useResumeBindingStore.getState();
    store.recordBinding("pty-1", "resume-manual", "manual");
    expect(store.recordBinding("pty-1", "resume-issued", "issued")).toBe(false);
    expect(useResumeBindingStore.getState().getBinding("pty-1")?.resumeId).toBe(
      "resume-manual",
    );
  });

  it("同值重放是幂等 no-op（daemon identity 事件补拉不涨版本）", () => {
    const store = useResumeBindingStore.getState();
    store.recordBinding("pty-1", "resume-a", "issued");
    const before = useResumeBindingStore.getState().getBinding("pty-1")?.version;
    expect(store.recordBinding("pty-1", "resume-a", "issued")).toBe(true);
    expect(useResumeBindingStore.getState().getBinding("pty-1")?.version).toBe(before);
  });
});

describe("persist merge", () => {
  it("rehydrate 时清除超过 TTL 的陈旧绑定", () => {
    const merge = useResumeBindingStore.persist.getOptions().merge!;
    const merged = merge(
      {
        bindings: {
          fresh: { resumeId: "r1", version: 1, updatedAt: Date.now() },
          stale: {
            resumeId: "r2",
            version: 1,
            updatedAt: Date.now() - RESUME_BINDING_TTL_MS - 1000,
          },
        },
      },
      useResumeBindingStore.getState(),
    ) as { bindings: Record<string, unknown> };
    expect(Object.keys(merged.bindings)).toEqual(["fresh"]);
  });
});
