import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { agentRuntimeService } from "./agentRuntimeService";

beforeEach(() => vi.clearAllMocks());
afterEach(() => { window.__TAURI_INTERNALS__ = {}; });

describe("durable run transport", () => {
  it("only reads local records with stable identity and pagination cursors", async () => {
    await agentRuntimeService.list({ engineId: "codex", acpSessionId: "stable-session", offset: 20 });
    await agentRuntimeService.events("run-1", 200);
    expect(invoke).toHaveBeenNthCalledWith(1, "list_acp_run_records", { engineId: "codex", acpSessionId: "stable-session", offset: 20 });
    expect(invoke).toHaveBeenNthCalledWith(2, "read_acp_run_events", { runId: "run-1", afterSeq: 200 });
  });
  it("fails clearly outside desktop instead of starting or resuming an agent", async () => {
    delete window.__TAURI_INTERNALS__;
    await expect(agentRuntimeService.list({})).rejects.toThrow("only available in the desktop app");
    expect(invoke).not.toHaveBeenCalled();
  });
});
