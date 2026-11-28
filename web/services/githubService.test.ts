import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { githubService, isGhReady } from "./githubService";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";

describe("githubService", () => {
  beforeEach(() => resetTauriInvoke());
  afterEach(() => {
    window.__TAURI_INTERNALS__ = {};
  });

  it("status 透传 refresh 参数", async () => {
    mockTauriInvoke({ github_cli_status: { installed: true, authenticated: true, account: "me" } });
    const status = await githubService.status(true);
    expect(invoke).toHaveBeenCalledWith("github_cli_status", { refresh: true });
    expect(isGhReady(status)).toBe(true);
  });

  it("Web 壳视为不可用，不调用 invoke", async () => {
    delete window.__TAURI_INTERNALS__;
    const status = await githubService.status();
    expect(isGhReady(status)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("listIssues 用 camelCase 参数并把空查询归一为 null", async () => {
    mockTauriInvoke({ github_list_issues: [] });
    await githubService.listIssues("/repo", "   ");
    expect(invoke).toHaveBeenCalledWith("github_list_issues", { projectPath: "/repo", query: null });
    await githubService.listIssues("/repo", " label:bug ");
    expect(invoke).toHaveBeenLastCalledWith("github_list_issues", {
      projectPath: "/repo",
      query: "label:bug",
    });
  });

  it("importIssues 传 issue 编号", async () => {
    mockTauriInvoke({ github_import_issues: [{ number: 3, alreadyImported: true }] });
    const results = await githubService.importIssues("/repo", [3]);
    expect(invoke).toHaveBeenCalledWith("github_import_issues", { projectPath: "/repo", numbers: [3] });
    expect(results[0].alreadyImported).toBe(true);
  });

  it("合并确认回执只携带 approved", async () => {
    mockTauriInvoke({ respond_orchestrator_query: undefined });
    await githubService.respondMergeConfirm("req-1", false);
    expect(invoke).toHaveBeenCalledWith("respond_orchestrator_query", {
      requestId: "req-1",
      data: JSON.stringify({ approved: false }),
    });
  });

  it("isGhReady 要求已安装且已登录", () => {
    expect(isGhReady(null)).toBe(false);
    expect(isGhReady({ installed: true, authenticated: false })).toBe(false);
  });
});
