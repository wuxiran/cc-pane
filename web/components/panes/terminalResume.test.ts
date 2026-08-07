import { beforeEach, describe, it, expect } from "vitest";
import { pickCreateSessionResumeId } from "./terminalResume";
import { useResumeBindingStore } from "@/stores/useResumeBindingStore";

beforeEach(() => {
  useResumeBindingStore.setState({ bindings: {} });
});

describe("pickCreateSessionResumeId", () => {
  it("returns the explicit resumeId from props", () => {
    expect(pickCreateSessionResumeId({ resumeId: "sess-123" })).toBe("sess-123");
  });

  it("never falls back to launch history when resumeId is absent", () => {
    // 回归断言：缺 resumeId 时必须按"新建"处理（undefined），
    // 不得按目录从 launch history 续接上次会话（commit 65c9a2f 的 bug）。
    expect(pickCreateSessionResumeId({ resumeId: undefined })).toBeUndefined();
    expect(pickCreateSessionResumeId({})).toBeUndefined();
  });

  // ResumeBindingStore 是权威镜像：快照 props.resumeId 是落盘时机决定的副本，
  // store 按 savedSessionId 精确命中时永远不旧于它（docs/86 必修4）。
  it("prefers the ResumeBindingStore binding for the exact saved session", () => {
    useResumeBindingStore.getState().recordBinding("pty-1", "resume-fresh", "issued");
    expect(
      pickCreateSessionResumeId({ resumeId: "resume-stale", savedSessionId: "pty-1" }),
    ).toBe("resume-fresh");
  });

  it("falls back to props.resumeId when the store has no binding", () => {
    expect(
      pickCreateSessionResumeId({ resumeId: "resume-snapshot", savedSessionId: "pty-miss" }),
    ).toBe("resume-snapshot");
  });

  it("ignores the store entirely without a savedSessionId (no directory hijack)", () => {
    useResumeBindingStore.getState().recordBinding("pty-other", "resume-other", "issued");
    expect(pickCreateSessionResumeId({ resumeId: undefined })).toBeUndefined();
  });
});
