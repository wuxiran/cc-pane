import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { usePanesStore } from "@/stores";
import FileSearchView from "./FileSearchView";

const mocks = vi.hoisted(() => ({
  searchProjectFiles: vi.fn(),
  searchProjectContents: vi.fn(),
  openEditor: vi.fn(),
}));

vi.mock("@/services/filesystemService", () => ({
  filesystemService: {
    searchProjectFiles: mocks.searchProjectFiles,
    searchProjectContents: mocks.searchProjectContents,
  },
}));

const tt = (key: string) => String(i18n.t(key as never));

async function flushDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("FileSearchView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.searchProjectFiles.mockResolvedValue({ paths: [], truncated: false });
    mocks.searchProjectContents.mockResolvedValue({
      matches: [],
      truncated: false,
      timedOut: false,
    });
    usePanesStore.setState({ openEditor: mocks.openEditor });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces name search for 200ms and opens a result", async () => {
    mocks.searchProjectFiles.mockResolvedValue({
      paths: ["src/main.ts"],
      truncated: false,
    });
    render(
      <FileSearchView rootPath="/repo">
        <div data-testid="tree">tree</div>
      </FileSearchView>,
    );

    const input = screen.getByPlaceholderText(tt("sidebar:filetree.searchPlaceholder"));
    fireEvent.change(input, { target: { value: "main" } });
    vi.advanceTimersByTime(199);
    expect(mocks.searchProjectFiles).not.toHaveBeenCalled();

    await flushDebounce();
    expect(mocks.searchProjectFiles).toHaveBeenCalledWith("/repo", "main", 200);
    expect(screen.getByText("src/main.ts")).toBeVisible();
    expect(screen.queryByTestId("tree")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("src/main.ts"));
    expect(mocks.openEditor).toHaveBeenCalledWith("/repo", "/repo/src/main.ts", "main.ts");
  });

  it("switches to content mode and discards an older name response", async () => {
    let resolveName: ((value: { paths: string[]; truncated: boolean }) => void) | undefined;
    mocks.searchProjectFiles.mockReturnValue(
      new Promise((resolve) => {
        resolveName = resolve;
      }),
    );
    mocks.searchProjectContents.mockResolvedValue({
      matches: [{ path: "src/new.ts", line: 7, preview: "const needle = true;" }],
      truncated: false,
      timedOut: false,
    });
    render(
      <FileSearchView rootPath="/repo">
        <div>tree</div>
      </FileSearchView>,
    );

    const input = screen.getByPlaceholderText(tt("sidebar:filetree.searchPlaceholder"));
    fireEvent.change(input, { target: { value: "needle" } });
    await flushDebounce();
    fireEvent.click(screen.getByRole("tab", { name: tt("sidebar:filetree.searchModeContent") }));
    await flushDebounce();
    expect(mocks.searchProjectContents).toHaveBeenCalledWith("/repo", "needle", 300);
    expect(screen.getByText("const needle = true;")).toBeVisible();
    expect(screen.getByText("src/new.ts:7")).toBeVisible();

    await act(async () => {
      resolveName?.({ paths: ["stale.ts"], truncated: false });
      await Promise.resolve();
    });
    expect(screen.queryByText("stale.ts")).not.toBeInTheDocument();
    expect(screen.getByText("src/new.ts:7")).toBeVisible();
  });

  it("shows the truncated hint and Escape returns to the tree", async () => {
    mocks.searchProjectFiles.mockResolvedValue({ paths: ["src/a.ts"], truncated: true });
    render(
      <FileSearchView rootPath="/repo">
        <div data-testid="tree">tree</div>
      </FileSearchView>,
    );

    const input = screen.getByPlaceholderText(tt("sidebar:filetree.searchPlaceholder"));
    fireEvent.change(input, { target: { value: "a" } });
    await flushDebounce();
    expect(screen.getByText(tt("sidebar:filetree.searchTruncated"))).toBeVisible();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(screen.getByTestId("tree")).toBeVisible();
  });
});
