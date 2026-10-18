import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskBindingService } from "./taskBindingService";
const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => runtime.desktop }));

beforeEach(() => { vi.clearAllMocks(); runtime.desktop = true; });

describe("durable task retry transport", () => {
  it("passes only the original identity to the dispatcher and returns its fresh binding", async () => {
    const binding = { id: "new-binding", sessionId: "new-session", metadata: { dispatchEnvelope: { bindingId: "new-binding", runtimeKind: "wsl" } } };
    vi.mocked(invoke).mockResolvedValue(binding);
    expect(await taskBindingService.retryDispatched("original-binding")).toBe(binding);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("retry_dispatched_task", { bindingId: "original-binding" });
  });

  it("does not fall back to a default terminal after a rejected retry", async () => {
    const error = new Error("Original workspace no longer exists");
    vi.mocked(invoke).mockRejectedValue(error);
    await expect(taskBindingService.retryDispatched("original-binding")).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("explicitly rejects when the desktop dispatcher is unavailable", async () => {
    runtime.desktop = false;
    await expect(taskBindingService.retryDispatched("original-binding")).rejects.toThrow("desktop app");
    expect(invoke).not.toHaveBeenCalled();
  });
});
