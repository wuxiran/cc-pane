import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import EditorView from "./EditorView";

const modifiedLabel = String(i18n.t("editor:modified"));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
    onMount,
    options,
  }: {
    value: string;
    onChange: (value: string | undefined) => void;
    onMount?: (editor: unknown) => void;
    options?: { readOnly?: boolean };
  }) => {
    onMount?.({
      addAction: vi.fn(),
      trigger: vi.fn(),
      onDidScrollChange: vi.fn(),
      getScrollTop: vi.fn(() => 0),
      getScrollHeight: vi.fn(() => 0),
      getLayoutInfo: vi.fn(() => ({ height: 0 })),
      setScrollTop: vi.fn(),
    });
    return (
      <textarea
        data-testid="monaco-stub"
        value={value}
        readOnly={options?.readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

vi.mock("@/services/filesystemService", () => ({
  filesystemService: {
    getEntryInfo: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { filesystemService } = await import("@/services/filesystemService");
const { toast } = await import("sonner");
const getEntryInfo = filesystemService.getEntryInfo as ReturnType<typeof vi.fn>;
const readFile = filesystemService.readFile as ReturnType<typeof vi.fn>;
const writeFile = filesystemService.writeFile as ReturnType<typeof vi.fn>;

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  }
});

const FILE = "/proj/src/main.ts";

function mockTextFile(content = "const x = 1;", encoding = "utf-8") {
  getEntryInfo.mockResolvedValue({ size: content.length, modified: "2026-01-01T00:00:00Z" });
  readFile.mockResolvedValue({ path: FILE, content, encoding, size: content.length, language: null });
}

async function renderLoaded(filePath = FILE, extra: Record<string, unknown> = {}) {
  render(<EditorView filePath={filePath} projectPath="/proj" onDirtyChange={vi.fn()} {...extra} />);
  await waitFor(() => expect(screen.queryByText("Loading file...")).not.toBeInTheDocument());
}

describe("EditorView regressions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a loading state before the file resolves", () => {
    getEntryInfo.mockReturnValue(new Promise(() => {}));
    render(<EditorView filePath={FILE} projectPath="/proj" onDirtyChange={vi.fn()} />);
    expect(screen.getByText("Loading file...")).toBeInTheDocument();
  });

  it("loads and shows the file content", async () => {
    mockTextFile("hello world");
    await renderLoaded();
    expect(screen.getByTestId("monaco-stub")).toHaveValue("hello world");
  });

  it("rejects files above the 5MB limit before reading", async () => {
    getEntryInfo.mockResolvedValue({ size: 6 * 1024 * 1024, modified: null });
    await renderLoaded();
    expect(screen.getByText(/File too large \(6\.0MB\)/)).toBeInTheDocument();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("refuses binary files", async () => {
    mockTextFile("\u0000\u0001", "binary");
    await renderLoaded();
    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
  });

  it("marks protected paths as read-only", async () => {
    mockTextFile();
    await renderLoaded("/proj/node_modules/pkg/index.js");
    expect(screen.getByText("Read-only (protected path)")).toBeInTheDocument();
    expect(screen.getByTestId("monaco-stub")).toHaveAttribute("readonly");
  });

  it("marks non-UTF-8 files as read-only with the encoding reason", async () => {
    mockTextFile("legacy", "gbk");
    await renderLoaded();
    expect(screen.getByText("Read-only (non UTF-8 encoding)")).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    getEntryInfo.mockRejectedValue(new Error("permission denied"));
    await renderLoaded();
    expect(screen.getByText(/Failed to load file/)).toBeInTheDocument();
  });

  it("reports dirty state through onDirtyChange when editing", async () => {
    mockTextFile("original");
    const onDirtyChange = vi.fn();
    await renderLoaded(FILE, { onDirtyChange });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByTestId("monaco-stub"), { target: { value: "changed" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(modifiedLabel)).toBeInTheDocument();
  });

  it("saves edited content and resets the dirty flag", async () => {
    const user = userEvent.setup();
    mockTextFile("original");
    writeFile.mockResolvedValue(undefined);
    await renderLoaded();
    fireEvent.change(screen.getByTestId("monaco-stub"), { target: { value: "changed" } });
    await user.click(screen.getAllByRole("button")[0]);
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith(FILE, "changed"));
    expect(toast.success).toHaveBeenCalledWith("File saved");
    await waitFor(() => expect(screen.queryByText(modifiedLabel)).not.toBeInTheDocument());
  });

  it("asks before overwriting an externally modified file and aborts on cancel", async () => {
    const user = userEvent.setup();
    mockTextFile("original");
    await renderLoaded();
    getEntryInfo.mockResolvedValue({ size: 8, modified: "2026-02-02T00:00:00Z" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.change(screen.getByTestId("monaco-stub"), { target: { value: "changed" } });
    await user.click(screen.getAllByRole("button")[0]);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith("File has been modified externally. Overwrite?"));
    expect(writeFile).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("renders the markdown preview when switching preview mode", async () => {
    const user = userEvent.setup();
    mockTextFile("# Title");
    await renderLoaded("/proj/README.md");
    await user.click(screen.getAllByRole("button")[4]);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-stub")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button")[5]);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByTestId("monaco-stub")).toBeInTheDocument();
  });

  it("routes image files to the image preview instead of the text editor", async () => {
    getEntryInfo.mockResolvedValue({ size: 100, modified: null });
    render(<EditorView filePath="/proj/logo.png" projectPath="/proj" onDirtyChange={vi.fn()} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
    await screen.findByText("100 B");
    expect(readFile).not.toHaveBeenCalled();
  });
});
