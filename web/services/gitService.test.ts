import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { gitService } from "./gitService";

describe("gitService", () => {
  beforeEach(() => resetTauriInvoke());

  it("通过统一命令获取 repo info", async () => {
    const info = {
      state: "ok" as const,
      repoRoot: "/repo",
      branch: "main",
      hasChanges: false,
      message: null,
    };
    mockTauriInvoke({ get_git_repo_info: info });

    await expect(gitService.getRepoInfo("/repo/subdir")).resolves.toEqual(info);
    expect(invoke).toHaveBeenCalledWith("get_git_repo_info", { path: "/repo/subdir" });
  });

  it("保留旧 file-statuses 返回结构", async () => {
    const statuses = { "/repo/a.txt": "modified" };
    mockTauriInvoke({ get_git_file_statuses: statuses });

    await expect(gitService.getFileStatuses("/repo")).resolves.toEqual(statuses);
    expect(invoke).toHaveBeenCalledWith("get_git_file_statuses", { path: "/repo" });
  });

  it("C2 Tauri 命令参数与共享模型保持一致", async () => {
    const file = {
      status: "modified" as const,
      oldPath: "a.txt",
      newPath: "a.txt",
      oldMode: "100644",
      newMode: "100644",
    };
    const page = { commits: [], hasMore: false, nextOffset: null };
    const diff = {
      hunks: [],
      stats: { additions: 0, deletions: 0, changes: 0 },
      isBinary: false,
      truncated: false,
      truncationReason: null,
      oldSize: 1,
      newSize: 1,
    };
    mockTauriInvoke({
      get_git_log: page,
      get_git_local_branches: ["main"],
      get_git_changed_files: [file],
      list_git_commit_files: [file],
      get_git_diff: diff,
    });

    await expect(gitService.getLog("/repo", { limit: 50, offset: 0, branch: "main" })).resolves.toEqual(page);
    await expect(gitService.getLocalBranches("/repo")).resolves.toEqual(["main"]);
    await expect(gitService.getChangedFiles("/repo")).resolves.toEqual([file]);
    await expect(gitService.listCommitFiles("/repo", "abc", 1)).resolves.toEqual([file]);
    await expect(gitService.getDiff("/repo", { mode: "worktreeVsHead", file })).resolves.toEqual(diff);

    expect(invoke).toHaveBeenCalledWith("get_git_log", {
      path: "/repo",
      query: { limit: 50, offset: 0, branch: "main" },
    });
    expect(invoke).toHaveBeenCalledWith("get_git_local_branches", { path: "/repo" });
    expect(invoke).toHaveBeenCalledWith("get_git_changed_files", { path: "/repo" });
    expect(invoke).toHaveBeenCalledWith("list_git_commit_files", {
      path: "/repo",
      commit: "abc",
      parentIndex: 1,
    });
    expect(invoke).toHaveBeenCalledWith("get_git_diff", {
      path: "/repo",
      spec: { mode: "worktreeVsHead", file },
    });
  });

  it("C2 Web API 与 Tauri service 使用同一请求语义", async () => {
    const original = window.__TAURI_INTERNALS__;
    delete window.__TAURI_INTERNALS__;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ commits: [], hasMore: false, nextOffset: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify(["main"])))
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        hunks: [],
        stats: { additions: 0, deletions: 0, changes: 0 },
        isBinary: false,
        truncated: false,
        truncationReason: null,
        oldSize: 0,
        newSize: 0,
      })));
    vi.stubGlobal("fetch", fetchMock);
    const file = {
      status: "added" as const,
      oldPath: null,
      newPath: "a.txt",
      oldMode: "000000",
      newMode: "100644",
    };

    try {
      await gitService.getLog("/repo", { limit: 50, offset: 0, branch: "main" });
      await gitService.getLocalBranches("/repo");
      await gitService.getChangedFiles("/repo");
      await gitService.listCommitFiles("/repo", "abc", 1);
      await gitService.getDiff("/repo", { mode: "worktreeVsHead", file });
    } finally {
      window.__TAURI_INTERNALS__ = original;
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/git/log?path=%2Frepo&limit=50&offset=0&branch=main",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/git/branches?path=%2Frepo", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/git/changed-files?path=%2Frepo", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/git/commit-files?path=%2Frepo&commit=abc&parentIndex=1",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/git/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/repo", spec: { mode: "worktreeVsHead", file } }),
    });
  });
});
