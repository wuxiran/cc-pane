import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { taskVerificationService } from "./taskVerificationService";

beforeEach(() => vi.clearAllMocks());
afterEach(() => { window.__TAURI_INTERNALS__ = {}; vi.unstubAllGlobals(); });

describe("task verification transport", () => {
  it("sends task identity and explicit command without a client-provided cwd", async () => {
    await taskVerificationService.list("task-1");
    await taskVerificationService.run("task-1", { command: "npm test", timeoutSecs: 30 });
    expect(invoke).toHaveBeenNthCalledWith(1, "list_task_verification", { taskId: "task-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "run_task_verification", {
      taskId: "task-1", request: { command: "npm test", timeoutSecs: 30 },
    });
  });

  it("uses matching REST bodies and escapes the task id", async () => {
    delete window.__TAURI_INTERNALS__;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await taskVerificationService.list("task/id");
    await taskVerificationService.run("task/id", { command: "npm test" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/task-bindings/task%2Fid/verification", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/task-bindings/task%2Fid/verification/run", expect.objectContaining({
      method: "POST", body: JSON.stringify({ command: "npm test" }),
    }));
  });

  it("surfaces duplicate-run conflicts to the caller", async () => {
    delete window.__TAURI_INTERNALS__;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Check already running", { status: 409 })));
    await expect(taskVerificationService.run("task-1", { command: "npm test" })).rejects.toThrow("Check already running");
  });
});
