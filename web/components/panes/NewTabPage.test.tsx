import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open, save } from "@tauri-apps/plugin-dialog";
import { createPanel } from "@/lib/paneTree";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores/usePanesStore";
import { findEditorTabByPathAcrossLayouts } from "@/stores/editorTabActions";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import NewTabPage from "./NewTabPage";
import { filesystemService } from "@/services/filesystemService";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/services/filesystemService", () => ({ filesystemService: { createFile: vi.fn() } }));
const tab: Tab = { id: "new-page", title: "New tab", contentType: "browser", browserUrl: "about:blank", projectId: "", projectPath: "", sessionId: null };

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  vi.mocked(filesystemService.createFile).mockResolvedValue(undefined);
  const source = createPanel(); source.id = "source"; source.tabs = [tab]; source.activeTabId = tab.id;
  const other = createPanel(); other.id = "other";
  const root = { type: "split" as const, id: "split", direction: "horizontal" as const, children: [source, other], sizes: [50, 50] };
  usePanesStore.setState({ rootPane: root, activePaneId: other.id, currentLayoutId: "layout", layouts: [{ id: "layout", name: "Layout", rootPane: root, activePaneId: other.id }] });
  useActivityBarStore.setState({ appViewMode: "panes" });
  useWorkspacesStore.setState({ workspaces: [], expandedProjectId: null, expandedWorkspaceId: null });
});

describe("NewTabPage", () => {
  it("navigates the existing tab and rejects non-web schemes", () => {
    render(<NewTabPage tab={tab} paneId="source" />);
    const address = screen.getByRole("textbox", { name: "Enter a website address" });
    fireEvent.change(address, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Open website" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(usePanesStore.getState().findTabAcrossLayouts(tab.id)?.tab.browserUrl).toBe("about:blank");
    fireEvent.change(address, { target: { value: "localhost:14206/demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Open website" }));
    expect(usePanesStore.getState().findTabAcrossLayouts(tab.id)?.tab.browserUrl).toBe("http://localhost:14206/demo");
  });

  it("opens a selected file in its source pane and derives a project for a projectless page", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/project/notes.md");
    render(<NewTabPage tab={tab} paneId="source" />);
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/project/notes.md")).toBeTruthy());
    const found = findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/project/notes.md")!;
    expect(found.panel.id).toBe("source");
    expect(found.tab.projectPath).toBe("/tmp/project");
    expect(usePanesStore.getState().activePaneId).toBe("source");
  });

  it("asks for a folder when opening a projectless review and keeps it in the source pane", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/repo");
    render(<NewTabPage tab={tab} paneId="source" />);
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(usePanesStore.getState().allPanels().flatMap((pane) => pane.tabs).some((item) => item.contentType === "review")).toBe(true));
    expect(open).toHaveBeenCalledWith({ multiple: false, directory: true });
    expect(usePanesStore.getState().activePaneId).toBe("source");
  });

  it("keeps the original layout when the user switches while the file picker is open", async () => {
    let choose!: (path: string) => void;
    vi.mocked(open).mockImplementationOnce(() => new Promise<string>((resolve) => { choose = resolve; }));
    render(<NewTabPage tab={tab} paneId="source" />);
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    let otherLayout = "";
    act(() => { otherLayout = usePanesStore.getState().createLayout("Other"); });
    act(() => { choose("/tmp/project/later.md"); });
    await waitFor(() => expect(findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/project/later.md")).toBeTruthy());
    const found = findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/project/later.md")!;
    expect(found.layoutId).toBe("layout");
    expect(found.panel.id).toBe("source");
    expect(usePanesStore.getState().currentLayoutId).toBe(otherLayout);
  });

  it("creates only an empty Markdown file and opens it in the source pane", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/pages/Notes");
    render(<NewTabPage tab={tab} paneId="source" />);
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    await waitFor(() => expect(findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/pages/Notes.md")).toBeTruthy());
    expect(save).toHaveBeenCalledWith({ defaultPath: "Untitled.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
    expect(filesystemService.createFile).toHaveBeenCalledExactlyOnceWith("/tmp/pages/Notes.md");
    const found = findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/pages/Notes.md")!;
    expect(found.panel.id).toBe("source");
    expect(found.tab.projectPath).toBe("/tmp/pages");
  });

  it("does nothing when creating a page is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    render(<NewTabPage tab={tab} paneId="source" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New page" })); });
    expect(filesystemService.createFile).not.toHaveBeenCalled();
    expect(usePanesStore.getState().listEditorTabsAcrossLayouts()).toEqual([]);
  });

  it("does not open a file after exclusive creation rejects an existing path", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/existing.md");
    vi.mocked(filesystemService.createFile).mockRejectedValue(new Error("already exists"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<NewTabPage tab={tab} paneId="source" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New page" })); });
    expect(filesystemService.createFile).toHaveBeenCalledExactlyOnceWith("/tmp/existing.md");
    expect(usePanesStore.getState().listEditorTabsAcrossLayouts()).toEqual([]);
    errorLog.mockRestore();
  });

  it("keeps one save dialog and the original layout while page creation is pending", async () => {
    let choose!: (path: string) => void;
    vi.mocked(save).mockImplementationOnce(() => new Promise<string>((resolve) => { choose = resolve; }));
    render(<NewTabPage tab={tab} paneId="source" />);
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    let otherLayout = "";
    act(() => { otherLayout = usePanesStore.getState().createLayout("Other"); });
    act(() => { choose("/tmp/pages/later.md"); });
    await waitFor(() => expect(findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/pages/later.md")).toBeTruthy());
    const found = findEditorTabByPathAcrossLayouts(usePanesStore.getState(), "/tmp/pages/later.md")!;
    expect(found.layoutId).toBe("layout");
    expect(found.panel.id).toBe("source");
    expect(usePanesStore.getState().currentLayoutId).toBe(otherLayout);
  });
});
