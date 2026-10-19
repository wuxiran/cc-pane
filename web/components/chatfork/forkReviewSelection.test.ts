import { describe, expect, it } from "vitest";
import type { ForkReviewRecord } from "@/types/forkReview";
import { relatedForks } from "./forkReviewSelection";

const record = (id: string, sourceCwd: string, sourceSessionId = "parent-session"): ForkReviewRecord => ({
  id, sourceCwd, sourceSessionId, targetCwd: `/fork/${id}`, createdAt: "2026-10-19T00:00:00Z", mode: "worktree",
  baseline: { repositoryRoot: sourceCwd, head: "head", tree: "tree", fingerprint: "fingerprint", snapshotRepository: "/snapshots" },
});

describe("related fork project identity", () => {
  it("groups Windows case, separator, verbatim-prefix and trailing-separator equivalents", () => {
    const current = record("current", "D:\\Repos\\Alpha");
    const sibling = record("sibling", "\\\\?\\d:\\repos\\ALPHA\\");
    const slash = record("slash", "d:/repos/alpha/");
    const differentProject = record("different-project", "D:/repos/beta");
    const differentSession = record("different-session", "D:/repos/alpha", "other-session");
    expect(relatedForks([current, sibling, slash, differentProject, differentSession], current).map((item) => item.id))
      .toEqual(["current", "sibling", "slash"]);
  });

  it("uses equivalent project paths for the parent-tab lookup and retains session filtering", () => {
    const sibling = record("sibling", "D:\\Repos\\Alpha");
    const differentSession = record("different-session", "/mnt/d/repos/alpha", "other-session");
    expect(relatedForks([sibling, differentSession], undefined, "/mnt/d/repos/alpha/", "parent-session"))
      .toEqual([sibling]);
  });

  it("keeps POSIX project paths case-sensitive", () => {
    const current = record("current", "/home/User/Repo");
    const sibling = record("sibling", "/home/User/Repo/");
    const differentCase = record("different-case", "/home/user/Repo");
    const differentSession = record("different-session", "/home/User/Repo", "other-session");
    expect(relatedForks([current, sibling, differentCase, differentSession], current).map((item) => item.id))
      .toEqual(["current", "sibling"]);
  });

  it("does not group unrelated records when no source identity is available", () => {
    expect(relatedForks([record("a", "/repo"), record("b", "/other")])).toEqual([]);
  });
});
