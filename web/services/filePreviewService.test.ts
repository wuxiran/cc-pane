import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { canUseLocalFileActions, filePreviewService } from "./filePreviewService";

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => runtime.desktop }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), revealItemInDir: vi.fn() }));

describe("filePreviewService", () => {
  beforeEach(() => { vi.clearAllMocks(); runtime.desktop = true; });

  it.each(["/Users/me/image.png", "C:\\Project\\image.png", "\\\\server\\share\\image.png"])("opens an absolute local path without shell interpolation: %s", async (path) => {
    expect(canUseLocalFileActions(path)).toBe(true);
    await filePreviewService.runDesktopAction(path, "openDefault");
    expect(openPath).toHaveBeenCalledWith(path);
  });

  it("reveals the selected file rather than opening its contents", async () => {
    await filePreviewService.runDesktopAction("/project/image.png", "reveal");
    expect(revealItemInDir).toHaveBeenCalledWith("/project/image.png");
    expect(openPath).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/a.png", "file:///tmp/a.png", "relative.png", "C:relative.png", "/tmp/bad\u0000.png"])("rejects nonlocal or malformed targets: %s", async (path) => {
    await expect(filePreviewService.runDesktopAction(path, "openDefault")).rejects.toThrow();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("rejects a remote file even when a local file has the same path", async () => {
    await expect(filePreviewService.runDesktopAction("/tmp/image.png", "reveal", true)).rejects.toThrow();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("does not dispatch native actions from Web mode", async () => {
    runtime.desktop = false;
    await expect(filePreviewService.runDesktopAction("/tmp/image.png", "reveal")).rejects.toThrow();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });
});
