import "@/i18n";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localChatPath, useChatFileActions } from "./useChatFileActions";

const fakes = vi.hoisted(() => ({
  info: vi.fn(), save: vi.fn(), notice: vi.fn(), reveal: vi.fn(), native: true,
  openEditor: vi.fn(), openExplorer: vi.fn(), activate: vi.fn(), find: vi.fn(),
  layout: "layout-a", activePane: "pane-a",
}));
vi.mock("@/services/filesystemService", () => ({ filesystemService: { getEntryInfo: fakes.info } }));
vi.mock("@/services/screenshotService", () => ({ screenshotService: { saveImageAttachment: fakes.save } }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => fakes.native }));
vi.mock("@/stores/useAgentChatStore", () => ({ useAgentChatStore: { getState: () => ({ pushNotice: fakes.notice }) } }));
vi.mock("@/stores/useEditorRevealStore", () => ({ useEditorRevealStore: { getState: () => ({ request: fakes.reveal }) } }));
vi.mock("@/stores/usePanesStore", () => ({ usePanesStore: { getState: () => ({
  currentLayoutId: fakes.layout, activePaneId: fakes.activePane, findTabAcrossLayouts: fakes.find,
  setActivePane: fakes.activate, openEditor: fakes.openEditor, openFileExplorer: fakes.openExplorer,
}) } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const options = { chatId: "chat-a", cwd: "/work/project", projectPath: "/work/project" };
beforeEach(() => {
  vi.clearAllMocks();
  fakes.native = true; fakes.layout = "layout-a"; fakes.activePane = "pane-a";
  fakes.find.mockReturnValue({ layoutId: "layout-a", panel: { id: "pane-a", activeTabId: "chat-a" } });
  fakes.activate.mockImplementation((paneId: string) => { fakes.activePane = paneId; });
  fakes.info.mockResolvedValue({ isDir: false, isFile: true });
  fakes.save.mockResolvedValue({ filePath: "/shots/pasted.png", width: 20, height: 10 });
});

describe("chat file tab actions", () => {
  it("resolves local paths but never treats remote, data or executable URL schemes as files", () => {
    expect(localChatPath("../image.png", "/work/project")).toBe("/work/image.png");
    expect(localChatPath("file:///tmp/a%20b.png", "")).toBe("/tmp/a b.png");
    expect(localChatPath("C:\\shots\\a.png", "")).toBe("C:\\shots\\a.png");
    for (const url of ["https://x/a.png", "data:image/png;base64,AA", "javascript:alert(1)", "//x/a.png", "a\u0000.png"]) {
      expect(localChatPath(url, "/work")).toBeNull();
    }
  });

  it("opens a verified local file with line reveal using the existing editor tab action", async () => {
    const { result } = renderHook(() => useChatFileActions(options));
    act(() => result.current.openLocation("src/main.ts", 24));
    await waitFor(() => expect(fakes.openEditor).toHaveBeenCalledWith("/work/project", "/work/project/src/main.ts", "main.ts", undefined, { forcePaneTab: true }));
    expect(fakes.reveal).toHaveBeenCalledWith("/work/project/src/main.ts", 24, 1);
  });

  it("honors the first file click in an inactive pane before the parent click bubbles", async () => {
    fakes.activePane = "pane-b";
    const { result } = renderHook(() => useChatFileActions(options));
    await act(() => result.current.openAttachment({ name: "result.png", path: "/project/result.png", data: "", mimeType: "" }));
    expect(fakes.activePane).toBe("pane-a");
    expect(fakes.openEditor).toHaveBeenCalledTimes(1);
  });

  it("routes directories, including image-named folders, to the file explorer", async () => {
    fakes.info.mockResolvedValue({ isDir: true, isFile: false });
    const { result } = renderHook(() => useChatFileActions(options));
    await act(() => result.current.openAttachment({ name: "assets.png", path: "/work/assets.png", kind: "file", data: "", mimeType: "", isDirectory: true }));
    expect(fakes.openExplorer).toHaveBeenCalledWith("/work/assets.png", "assets.png");
    expect(fakes.openEditor).not.toHaveBeenCalled();
  });

  it("persists actual inline bytes once across concurrent and later clicks, retaining the original payload", async () => {
    const save = deferred<{ filePath: string; width: number; height: number }>();
    fakes.save.mockReturnValue(save.promise);
    const attachment = Object.freeze({ name: "pasted.png", data: "aW1hZ2U=", mimeType: "image/png", kind: "image" as const });
    const { result } = renderHook(() => useChatFileActions(options));
    const first = result.current.openAttachment(attachment);
    const second = result.current.openAttachment(attachment);
    expect(fakes.save).toHaveBeenCalledExactlyOnceWith("aW1hZ2U=");
    await act(async () => { save.resolve({ filePath: "/shots/pasted.png", width: 20, height: 10 }); await Promise.all([first, second]); });
    await act(() => result.current.openAttachment(attachment));
    expect(fakes.save).toHaveBeenCalledTimes(1);
    expect(attachment).toEqual({ name: "pasted.png", data: "aW1hZ2U=", mimeType: "image/png", kind: "image" });
    expect(fakes.openEditor).toHaveBeenCalledWith("/work/project", "/shots/pasted.png", "pasted.png", undefined, { forcePaneTab: true });
  });

  it.each(["layout", "pane", "tab", "closed", "unmounted", "cwd"])("does not steal focus after the origin changes: %s", async (change) => {
    const info = deferred<{ isDir: boolean; isFile: boolean }>();
    fakes.info.mockReturnValue(info.promise);
    const { result, unmount, rerender } = renderHook((cwd: string) => useChatFileActions({ ...options, cwd }), { initialProps: options.cwd });
    act(() => result.current.openLocation("readme.md"));
    if (change === "layout") fakes.layout = "layout-b";
    if (change === "pane") fakes.activePane = "pane-b";
    if (change === "tab") fakes.find.mockReturnValue({ layoutId: "layout-a", panel: { id: "pane-a", activeTabId: "chat-b" } });
    if (change === "closed") fakes.find.mockReturnValue(null);
    if (change === "unmounted") unmount();
    if (change === "cwd") rerender("/other");
    await act(async () => { info.resolve({ isDir: false, isFile: true }); await info.promise; });
    expect(fakes.openEditor).not.toHaveBeenCalled(); expect(fakes.activate).not.toHaveBeenCalled();
  });

  it("falls back to quick preview for a browser-only inline image", async () => {
    fakes.native = false;
    const { result } = renderHook(() => useChatFileActions(options));
    expect(await result.current.openAttachment({ name: "pasted.png", data: "AA==", mimeType: "image/png" })).toBe(false);
    expect(fakes.save).not.toHaveBeenCalled(); expect(fakes.openEditor).not.toHaveBeenCalled();
  });

  it("reports an unavailable pathless file instead of leaving a dead open action", async () => {
    const { result } = renderHook(() => useChatFileActions(options));
    expect(await result.current.openAttachment({ name: "missing.md", kind: "file", data: "", mimeType: "" })).toBe(true);
    expect(fakes.notice).toHaveBeenCalledWith("chat-a", expect.stringContaining("本地文件"));
    expect(fakes.save).not.toHaveBeenCalled(); expect(fakes.info).not.toHaveBeenCalled();
  });

  it("shows file errors in the originating chat and rejects oversized inline bytes before IPC", async () => {
    const { result } = renderHook(() => useChatFileActions(options));
    await act(() => result.current.openAttachment({ name: "remote.png", path: "https://x/a.png", data: "", mimeType: "" }));
    expect(fakes.info).not.toHaveBeenCalled();
    expect(fakes.notice).toHaveBeenCalledWith("chat-a", expect.any(String));
    await act(() => result.current.openAttachment({ name: "large.png", data: "A".repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 1), mimeType: "image/png" }));
    expect(fakes.save).not.toHaveBeenCalled();
    expect(fakes.notice).toHaveBeenCalledTimes(2);
  });

  it("evicts a failed saved-file cache so a later click can recreate expired screenshot data", async () => {
    const { result } = renderHook(() => useChatFileActions({ ...options, cwd: "", projectPath: "" }));
    const attachment = { name: "pasted.png", data: "AA==", mimeType: "image/png" };
    fakes.info.mockRejectedValueOnce(new Error("file no longer exists"));
    await act(() => result.current.openAttachment(attachment));
    await act(() => result.current.openAttachment(attachment));
    expect(fakes.save).toHaveBeenCalledTimes(2);
    expect(fakes.openEditor).toHaveBeenCalledWith("/shots", "/shots/pasted.png", "pasted.png", undefined, { forcePaneTab: true });
  });

  it("keeps a drive-root project fallback absolute for Windows attachments without a chat cwd", async () => {
    const { result } = renderHook(() => useChatFileActions({ ...options, cwd: "", projectPath: "" }));
    await act(() => result.current.openAttachment({ name: "a.png", path: "C:\\a.png", mimeType: "", data: "" }));
    expect(fakes.openEditor).toHaveBeenCalledWith("C:\\", "C:\\a.png", "a.png", undefined, { forcePaneTab: true });
  });
});
