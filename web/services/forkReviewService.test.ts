import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { forkReviewService } from "./forkReviewService";

const request = { cwd: "/repo/sub", mode: "worktree" as const, sourceTabId: "parent", childTabId: "child", sourceSessionId: "session" };
const adoption = { revision: "preview", selections: [{ path: "src/file.ts", hunkIds: ["hunk-1"] }] };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { window.__TAURI_INTERNALS__ = {}; vi.unstubAllGlobals(); });

describe("fork review transport contract", () => {
  it("passes the preparation and revision-bearing adoption requests unchanged to desktop commands", async () => {
    await forkReviewService.prepare(request);
    await forkReviewService.list();
    await forkReviewService.compare("review");
    await forkReviewService.apply("review", adoption);
    expect(invoke).toHaveBeenNthCalledWith(1, "prepare_chat_fork", { request });
    expect(invoke).toHaveBeenNthCalledWith(2, "list_fork_reviews");
    expect(invoke).toHaveBeenNthCalledWith(3, "get_fork_comparison", { id: "review" });
    expect(invoke).toHaveBeenNthCalledWith(4, "apply_fork_changes", { id: "review", request: adoption });
  });
  it("uses equivalent REST bodies and escaped review ids for web clients", async () => {
    delete window.__TAURI_INTERNALS__;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await forkReviewService.prepare(request);
    await forkReviewService.list();
    await forkReviewService.compare("review/id");
    await forkReviewService.apply("review/id", adoption);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/fork-reviews/prepare", expect.objectContaining({ method: "POST", body: JSON.stringify(request) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/fork-reviews", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/fork-reviews/review%2Fid", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/fork-reviews/review%2Fid/apply", expect.objectContaining({ method: "POST", body: JSON.stringify(adoption) }));
  });
  it("propagates stale and conflicting write errors for the reload flow", async () => {
    delete window.__TAURI_INTERNALS__;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Preview changed; reload", { status: 409 })));
    await expect(forkReviewService.apply("review", adoption)).rejects.toThrow("Preview changed; reload");
  });
});
