import { describe, it, expect, beforeEach, vi } from "vitest";

const nativeConfirm = vi.fn();
const respondMergeConfirm = vi.fn();

vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: (...args: unknown[]) => nativeConfirm(...args) }));
vi.mock("@/services/githubService", () => ({
  githubService: { respondMergeConfirm: (...args: unknown[]) => respondMergeConfirm(...args) },
}));

import { handleMergeConfirm, mergeConfirmMessage, type GhMergeConfirmPayload } from "./useGithubMergeConfirm";

const payload: GhMergeConfirmPayload = {
  requestId: "req-1",
  projectPath: "/repo",
  number: 42,
  title: "feat: x",
  url: "https://github.com/o/r/pull/42",
  baseRefName: "dev/v0.13.5",
  headRefName: "feat/x",
  method: "squash",
};

describe("useGithubMergeConfirm", () => {
  beforeEach(() => {
    nativeConfirm.mockReset();
    respondMergeConfirm.mockReset().mockResolvedValue(undefined);
  });

  it("确认文案包含 PR 编号与分支", () => {
    const message = mergeConfirmMessage(payload);
    expect(message).toContain("42");
    expect(message).toContain("feat/x");
    expect(message).toContain("dev/v0.13.5");
  });

  it("用户确认后回 approved=true", async () => {
    nativeConfirm.mockResolvedValue(true);
    await handleMergeConfirm(payload);
    expect(respondMergeConfirm).toHaveBeenCalledWith("req-1", true);
  });

  it("用户取消回 approved=false", async () => {
    nativeConfirm.mockResolvedValue(false);
    await handleMergeConfirm(payload);
    expect(respondMergeConfirm).toHaveBeenCalledWith("req-1", false);
  });

  it("确认框出错按拒绝处理", async () => {
    nativeConfirm.mockRejectedValue(new Error("boom"));
    await handleMergeConfirm(payload);
    expect(respondMergeConfirm).toHaveBeenCalledWith("req-1", false);
  });
});
