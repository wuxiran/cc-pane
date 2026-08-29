import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { agentTranscriptService } from "./agentTranscriptService";

describe("agentTranscriptService", () => {
  beforeEach(() => resetTauriInvoke());

  afterEach(() => {
    window.__TAURI_INTERNALS__ = {};
    vi.unstubAllGlobals();
  });

  it("invokes read_agent_transcript_cmd with params", async () => {
    const result = {
      messages: [{ id: "1", role: "user" as const, text: "hi" }],
      truncated: false,
      totalEstimate: 1,
    };
    mockTauriInvoke({ read_agent_transcript_cmd: result });
    await expect(
      agentTranscriptService.read({
        cliTool: "grok",
        resumeSessionId: "abc",
        cwd: "D:\\proj",
        limit: 50,
      }),
    ).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("read_agent_transcript_cmd", {
      params: {
        cliTool: "grok",
        resumeSessionId: "abc",
        cwd: "D:\\proj",
        limit: 50,
      },
    });
  });
});
