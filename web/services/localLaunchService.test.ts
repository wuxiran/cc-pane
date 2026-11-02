import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLocalSessionCwd } from "./localLaunchService";
import { worktreeService } from "./worktreeService";

vi.mock("./worktreeService", () => ({ worktreeService: { add: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe("prepareLocalSessionCwd", () => {
  it("reuses the original directory without a Git mutation by default", async () => {
    await expect(prepareLocalSessionCwd("/repo")).resolves.toBe("/repo");
    expect(worktreeService.add).not.toHaveBeenCalled();
  });
  it("creates an isolated branch from the selected ref", async () => {
    vi.mocked(worktreeService.add).mockResolvedValue("/repo-worktrees/cc-task");
    await expect(prepareLocalSessionCwd("/repo", {
      enabled: true, branch: "cc/task", baseRef: "refs/heads/release",
    })).resolves.toBe("/repo-worktrees/cc-task");
    expect(worktreeService.add).toHaveBeenCalledWith("/repo", "cc-task", "cc/task", "refs/heads/release", true);
  });
  it("rejects an empty new branch and surfaces creation failure", async () => {
    await expect(prepareLocalSessionCwd("/repo", { enabled: true, branch: " " })).rejects.toThrow();
    expect(worktreeService.add).not.toHaveBeenCalled();
    vi.mocked(worktreeService.add).mockRejectedValue(new Error("branch exists"));
    await expect(prepareLocalSessionCwd("/repo", { enabled: true, branch: "cc/task" })).rejects.toThrow("branch exists");
  });
});
