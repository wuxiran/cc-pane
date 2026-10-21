import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatAttachmentList from "./ChatAttachmentList";
import { chatAttachmentPreview } from "./chatAttachmentPreview";

vi.mock("@/utils/assetUrl", () => ({ toAssetUrl: (path: string) => `asset://local/${encodeURIComponent(path)}` }));

const image = { name: "screen.png", mimeType: "image/png", data: "YWJj" };

describe("chat attachment preview", () => {
  it("renders legacy kind-omitted images and local file references, but never arbitrary URL resources", () => {
    expect(chatAttachmentPreview(image)).toBe("data:image/png;base64,YWJj");
    expect(chatAttachmentPreview({ ...image, data: "", kind: "file", path: "/tmp/shot.png" })).toContain("asset://local/");
    expect(chatAttachmentPreview({ ...image, data: "", kind: "file", path: "https://other.test/image.png" })).toBeNull();
    expect(chatAttachmentPreview({ ...image, mimeType: "text/html" })).toBeNull();
    expect(chatAttachmentPreview({ ...image, mimeType: "image/svg+xml" })).toBeNull();
    expect(chatAttachmentPreview({ ...image, path: "/tmp/assets.png", isDirectory: true })).toBeNull();
  });

  it("opens an accessible preview, closes with Escape, and removes the selected attachment", async () => {
    const remove = vi.fn();
    render(<ChatAttachmentList attachments={[image]} onRemove={remove} />);
    expect(screen.getByRole("img", { name: "screen.png" })).toHaveAttribute("src", "data:image/png;base64,YWJj");
    fireEvent.click(screen.getByRole("button", { name: "预览 screen.png" }));
    expect(screen.getByRole("dialog", { name: "screen.png" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "预览 screen.png" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "移除附件" }));
    expect(remove).toHaveBeenCalledWith(0);
  });

  it("replaces failed image loads with a file card instead of a broken preview button", () => {
    render(<ChatAttachmentList attachments={[image]} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "预览 screen.png" })).not.toBeInTheDocument();
    expect(screen.getByText("screen.png")).toBeInTheDocument();
  });

  it("opens attachments in a tab by default while keeping a separate quick-preview action", async () => {
    const open = vi.fn().mockResolvedValue(true);
    const { container } = render(<ChatAttachmentList attachments={[image]} onOpenAttachment={open} />);
    fireEvent.click(screen.getByRole("button", { name: "在标签页中打开 screen.png" }));
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(image));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "快速预览 screen.png" }));
    expect(screen.getByRole("dialog", { name: "screen.png" })).toBeInTheDocument();
    expect(container.querySelector("button button")).toBeNull();
  });

  it("falls back to the quick preview when inline persistence is unavailable", async () => {
    render(<ChatAttachmentList attachments={[image]} onOpenAttachment={vi.fn().mockResolvedValue(false)} />);
    fireEvent.click(screen.getByRole("button", { name: "在标签页中打开 screen.png" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "screen.png" })).toBeInTheDocument());
  });

  it("opens file and directory chips, and reports errors without silently dismissing them", async () => {
    const folder = { name: "assets.png", path: "/tmp/assets.png", data: "", mimeType: "", isDirectory: true };
    render(<ChatAttachmentList attachments={[folder]} onOpenAttachment={vi.fn().mockRejectedValue(new Error("Missing directory"))} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在标签页中打开 assets.png" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Missing directory"));
  });
});
