import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { sessionIndexService } from "./sessionIndexService";

describe("sessionIndexService", () => {
  beforeEach(() => resetTauriInvoke());

  afterEach(() => {
    window.__TAURI_INTERNALS__ = {};
    vi.unstubAllGlobals();
  });

  it("lists indexed sessions through the shared params object", async () => {
    mockTauriInvoke({ list_session_index: [] });
    const params = {
      scope: "project" as const,
      projectPath: "/workspace/alpha",
      query: "index",
      cliFilter: "codex" as const,
      limit: 100,
      offset: 0,
    };

    await sessionIndexService.list(params);

    expect(invoke).toHaveBeenCalledWith("list_session_index", { params });
  });

  it("refreshes the cache and preserves the scan report", async () => {
    const report = { rootsScanned: 2, filesSeen: 10, filesParsed: 1, filesSkipped: 9, bytesRead: 512 };
    mockTauriInvoke({ refresh_session_index: report });

    await expect(sessionIndexService.refresh()).resolves.toEqual(report);
    expect(invoke).toHaveBeenCalledWith("refresh_session_index");
  });

  it("returns the tri-state Codex rollout preflight result", async () => {
    mockTauriInvoke({ check_codex_rollout_exists: false });

    await expect(
      sessionIndexService.checkCodexRollout("session-1", "Ubuntu"),
    ).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("check_codex_rollout_exists", {
      sessionId: "session-1",
      wslDistro: "Ubuntu",
    });
  });

  it("flattens list params into the REST query string", async () => {
    delete window.__TAURI_INTERNALS__;
    const fetchMock = vi.fn(() => Promise.resolve(new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await sessionIndexService.list({
      scope: "workspace",
      workspaceName: "main workspace",
      cliFilter: "claude",
      limit: 100,
      offset: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session-index?scope=workspace&workspaceName=main+workspace&cliFilter=claude&limit=100&offset=0",
      undefined,
    );
  });
});
