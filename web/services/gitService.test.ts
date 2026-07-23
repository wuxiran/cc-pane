import { beforeEach, describe, expect, it } from "vitest";
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
});
