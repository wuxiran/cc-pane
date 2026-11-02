import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { codexDesktopService } from "./codexDesktopService";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./runtime", () => ({ isTauriRuntime: vi.fn(() => true) }));

beforeEach(() => { vi.clearAllMocks(); vi.mocked(isTauriRuntime).mockReturnValue(true); });

describe("Codex desktop opener", () => {
  it("passes an explicit thread or project draft to the validated backend", async () => {
    vi.mocked(invoke).mockResolvedValue("codex://threads/thread-id");
    await expect(codexDesktopService.open({ cwd: "", threadId: "thread-id" })).resolves.toBe("codex://threads/thread-id");
    expect(invoke).toHaveBeenLastCalledWith("open_in_codex", { cwd: "", threadId: "thread-id" });
    await codexDesktopService.open({ cwd: "/repo with spaces", prompt: "draft only" });
    expect(invoke).toHaveBeenLastCalledWith("open_in_codex", { cwd: "/repo with spaces", prompt: "draft only" });
  });

  it("does not invoke the backend for unsafe input or a web-only runtime", async () => {
    await expect(codexDesktopService.open({ cwd: "/repo", threadId: "thread-id", prompt: "must not be discarded" })).rejects.toThrow("cannot append");
    await expect(codexDesktopService.open({ cwd: "/repo", prompt: "中".repeat(3000) })).rejects.toThrow("too long");
    await expect(codexDesktopService.open({ cwd: "/repo", threadId: "../evil" })).rejects.toThrow("Invalid Codex thread ID");
    await expect(codexDesktopService.open({ cwd: "relative" })).rejects.toThrow("local absolute");
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    await expect(codexDesktopService.open({ cwd: "/repo" })).rejects.toThrow("desktop app");
    expect(invoke).not.toHaveBeenCalled();
  });
});
