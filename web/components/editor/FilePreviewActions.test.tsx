import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filePreviewService } from "@/services/filePreviewService";
import { toastErr } from "@/lib/feedback";
import FilePreviewActions from "./FilePreviewActions";

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => runtime.desktop }));
vi.mock("@/services/filePreviewService", async (original) => ({
  ...await original<typeof import("@/services/filePreviewService")>(),
  filePreviewService: { runDesktopAction: vi.fn() },
}));
vi.mock("@/lib/feedback", () => ({ toastErr: vi.fn(), toastOk: vi.fn() }));

describe("FilePreviewActions", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); vi.clearAllMocks(); runtime.desktop = true; });

  it("opens and reveals the displayed file only after the corresponding click", async () => {
    const user = userEvent.setup();
    render(<FilePreviewActions filePath="/repo/image.png" projectPath="/repo" />);
    expect(filePreviewService.runDesktopAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open in default app" }));
    expect(filePreviewService.runDesktopAction).toHaveBeenLastCalledWith("/repo/image.png", "openDefault", false);
    await user.click(screen.getByRole("button", { name: "Show in file manager" }));
    expect(filePreviewService.runDesktopAction).toHaveBeenLastCalledWith("/repo/image.png", "reveal", false);
  });

  it.each([
    ["/repo/assets/image.png", "/repo", "assets/image.png"],
    ["C:\\Repo\\assets\\image.png", "c:\\repo", "assets/image.png"],
    ["\\\\server\\share\\repo\\image.png", "\\\\server\\share\\repo", "image.png"],
  ])("copies a project-relative path for %s", async (filePath, projectPath, expected) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<FilePreviewActions filePath={filePath} projectPath={projectPath} />);
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy project-relative path" }));
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  it("does not offer an incorrect relative path for a sibling directory", async () => {
    const user = userEvent.setup();
    render(<FilePreviewActions filePath="/repository/image.png" projectPath="/repo" />);
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(screen.queryByRole("menuitem", { name: "Copy project-relative path" })).not.toBeInTheDocument();
  });

  it("copies remote names without treating POSIX backslashes as separators", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<FilePreviewActions filePath={"/srv/a\\b.png"} projectPath="/srv" isRemote />);
    expect(screen.queryByRole("button", { name: "Open in default app" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in file manager" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy file name" }));
    expect(writeText).toHaveBeenCalledWith("a\\b.png");
  });

  it("keeps copy available in Web mode and hides desktop actions", () => {
    runtime.desktop = false;
    render(<FilePreviewActions filePath="/repo/image.png" />);
    expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in default app" })).not.toBeInTheDocument();
  });

  it("reports action and clipboard failures", async () => {
    const user = userEvent.setup();
    vi.mocked(filePreviewService.runDesktopAction).mockRejectedValueOnce(new Error("file missing"));
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard denied"));
    render(<FilePreviewActions filePath="/repo/image.png" />);
    await user.click(screen.getByRole("button", { name: "Open in default app" }));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith("Could not open the file. It may have moved or been deleted."));
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy full path" }));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith("Could not copy the path"));
  });
});
