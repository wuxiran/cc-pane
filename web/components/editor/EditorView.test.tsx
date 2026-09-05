import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { filesystemService } from "@/services/filesystemService";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import EditorView from "./EditorView";

const monacoHarness = vi.hoisted(() => ({ props: null as null | { onMount: (editor: unknown) => void } }));

vi.mock("./MonacoCodeEditor", () => ({
  default: (props: { onMount: (editor: unknown) => void }) => {
    monacoHarness.props = props;
    return <div data-testid="monaco-editor" />;
  },
}));
vi.mock("@/services/filesystemService", () => ({
  filesystemService: {
    getEntryInfo: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./EditorToolbar", () => ({
  default: ({ onPreviewModeChange }: { onPreviewModeChange: (mode: "preview") => void }) => (
    <button type="button" onClick={() => onPreviewModeChange("preview")}>preview</button>
  ),
}));
vi.mock("./EditorBreadcrumb", () => ({ default: () => <div /> }));
vi.mock("./MarkdownPreview", () => ({ default: () => <div /> }));
vi.mock("./ImagePreview", () => ({ default: () => <div data-testid="image-preview" /> }));

describe("EditorView terminal path reveal", () => {
  beforeEach(() => {
    monacoHarness.props = null;
    useEditorRevealStore.getState().resetForTest();
    vi.mocked(filesystemService.getEntryInfo).mockResolvedValue({ size: 8, modified: "1" } as never);
    vi.mocked(filesystemService.readFile).mockResolvedValue({ content: "one\ntwo", encoding: "utf-8" } as never);
  });

  it("clamps, focuses, and consumes a reveal request after Monaco mounts", async () => {
    const filePath = "C:/repo/src/App.tsx";
    useEditorRevealStore.getState().request(filePath, 99, 99);
    render(<EditorView filePath={filePath} projectPath="C:/repo" />);
    await screen.findByTestId("monaco-editor");

    const editor = {
      onDidScrollChange: vi.fn(),
      addAction: vi.fn(),
      getModel: () => ({ getLineCount: () => 2, getLineMaxColumn: () => 4 }),
      setPosition: vi.fn(),
      revealPositionInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(),
    };
    act(() => monacoHarness.props?.onMount(editor));

    await waitFor(() => expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 4 }));
    expect(editor.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledWith({ lineNumber: 2, column: 4 });
    expect(editor.focus).toHaveBeenCalled();
    expect(useEditorRevealStore.getState().requests[filePath]).toBeUndefined();
  });

  it("handles a new request for an already mounted editor", async () => {
    const filePath = "C:/repo/src/App.tsx";
    render(<EditorView filePath={filePath} projectPath="C:/repo" />);
    await screen.findByTestId("monaco-editor");
    const editor = {
      onDidScrollChange: vi.fn(),
      addAction: vi.fn(),
      getModel: () => ({ getLineCount: () => 20, getLineMaxColumn: () => 10 }),
      setPosition: vi.fn(),
      revealPositionInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(),
    };
    act(() => monacoHarness.props?.onMount(editor));

    act(() => { useEditorRevealStore.getState().request(filePath, 12, 8); });

    await waitFor(() => expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 12, column: 8 }));
  });

  it("switches Markdown preview back to Monaco before consuming a reveal request", async () => {
    const filePath = "C:/repo/docs/readme.md";
    render(<EditorView filePath={filePath} projectPath="C:/repo" />);
    await screen.findByTestId("monaco-editor");
    const editor = {
      onDidScrollChange: vi.fn(),
      addAction: vi.fn(),
      getModel: () => ({ getLineCount: () => 20, getLineMaxColumn: () => 10 }),
      setPosition: vi.fn(),
      revealPositionInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(),
    };
    act(() => monacoHarness.props?.onMount(editor));
    fireEvent.click(screen.getByRole("button", { name: "preview" }));
    expect(screen.queryByTestId("monaco-editor")).not.toBeInTheDocument();

    act(() => { useEditorRevealStore.getState().request(filePath, 7, 3); });

    await screen.findByTestId("monaco-editor");
    await waitFor(() => expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 7, column: 3 }));
    expect(useEditorRevealStore.getState().requests[filePath]).toBeUndefined();
  });

  it("consumes a reveal request when a binary file cannot mount Monaco", async () => {
    const filePath = "C:/repo/assets/data.bin";
    useEditorRevealStore.getState().request(filePath, 3);
    vi.mocked(filesystemService.readFile).mockResolvedValue({ content: "", encoding: "binary" } as never);

    render(<EditorView filePath={filePath} projectPath="C:/repo" />);

    await waitFor(() => expect(useEditorRevealStore.getState().requests[filePath]).toBeUndefined());
  });

  it("consumes stale reveal requests for image previews", async () => {
    const filePath = "C:/repo/assets/logo.png";
    useEditorRevealStore.getState().request(filePath, 3);

    render(<EditorView filePath={filePath} projectPath="C:/repo" />);

    await screen.findByTestId("image-preview");
    await waitFor(() => expect(useEditorRevealStore.getState().requests[filePath]).toBeUndefined());
  });
});
