import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";
import { useEditorBuffersStore } from "@/stores/useEditorBuffersStore";
import FileEditorPanel from "./FileEditorPanel";

const io = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), info: vi.fn(), remoteRead: vi.fn(), remoteWrite: vi.fn(),
  mounted: 0,
}));
vi.mock("./MonacoCodeEditor", () => ({
  default: ({ value, onChange, onMount }: {
    value: string; onChange: (value: string) => void; onMount: (editor: unknown) => void;
  }) => {
    useEffect(() => {
      io.mounted += 1;
      onMount({ addAction: vi.fn(), onDidScrollChange: vi.fn() });
      return () => { io.mounted -= 1; };
    }, []);
    return <textarea data-testid="buffer-editor" value={value} onChange={(event) => onChange(event.target.value)} />;
  },
}));
vi.mock("./monacoProductActions", () => ({ registerMonacoProductActions: vi.fn() }));
vi.mock("@/services/filesystemService", () => ({
  filesystemService: { readFile: io.read, writeFile: io.write, getEntryInfo: io.info },
}));
vi.mock("@/services/sshFileService", () => ({
  sshFileService: { readFile: io.remoteRead, writeFile: io.remoteWrite },
}));
vi.mock("./EditorToolbar", () => ({
  default: ({ onSave }: { onSave: () => void }) => <button onClick={onSave}>save-buffer</button>,
}));

function open(name: string) {
  useEditorTabsStore.getState().openFile("/project", `/project/${name}.ts`, `${name}.ts`);
  return useEditorTabsStore.getState().activeTabId!;
}

function edit(value: string) {
  fireEvent.change(screen.getByTestId("buffer-editor"), { target: { value } });
}

function closeButton(title: string) {
  const tab = screen.getAllByText(title).map((element) => element.closest("div[draggable]")).find(Boolean)!;
  return tab.querySelector("svg.lucide-x")!.parentElement!;
}

type BulkCloseAction = "closeOtherTabs" | "closeTabsToLeft" | "closeTabsToRight";

async function closeMenu(title: string, action: BulkCloseAction) {
  const tab = screen.getAllByText(title).map((element) => element.closest("div[draggable]")).find(Boolean)!;
  fireEvent.contextMenu(tab);
  fireEvent.click(await screen.findByText(i18n.t(`panes:${action}`)));
}

async function confirmClose() {
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("panes:closeTabConfirmAction") }));
}

beforeEach(() => {
  vi.clearAllMocks();
  io.mounted = 0;
  useEditorTabsStore.setState({ tabs: [], activeTabId: null, recentFiles: [] });
  useEditorBuffersStore.setState({ buffers: {} });
  io.read.mockImplementation(async (path: string) => ({ content: `disk:${path}`, encoding: "utf-8" }));
  io.info.mockResolvedValue({ size: 20, modified: "mtime-1" });
  io.write.mockResolvedValue(undefined);
  io.remoteRead.mockImplementation(async (machine: string) => ({ content: machine, encoding: "utf-8" }));
  io.remoteWrite.mockResolvedValue(undefined);
});

describe("Files editor buffer ownership", () => {
  it("refreshes clean buffers after external edits while preserving dirty buffers", async () => {
    const a = open("a");
    const b = open("b");
    useEditorTabsStore.getState().selectTab(a);
    render(<FileEditorPanel />);
    expect(await screen.findByTestId("buffer-editor")).toHaveValue("disk:/project/a.ts");
    act(() => useEditorTabsStore.getState().selectTab(b));
    await screen.findByTestId("buffer-editor");
    io.read.mockResolvedValue({ content: "external update", encoding: "utf-8" });
    act(() => useEditorTabsStore.getState().selectTab(a));
    await waitFor(() => expect(screen.getByTestId("buffer-editor")).toHaveValue("external update"));
    edit("unsaved after refresh");
    act(() => useEditorTabsStore.getState().selectTab(b));
    await screen.findByTestId("buffer-editor");
    act(() => useEditorTabsStore.getState().selectTab(a));
    expect(screen.getByTestId("buffer-editor")).toHaveValue("unsaved after refresh");
    expect(io.read.mock.calls.filter(([path]) => path === "/project/a.ts")).toHaveLength(2);
  });

  it("retains unsaved text across tab and app-view unmounts with only one Monaco mounted", async () => {
    const a = open("a");
    const b = open("b");
    useEditorTabsStore.getState().selectTab(a);
    const panel = render(<FileEditorPanel />);
    await screen.findByTestId("buffer-editor");
    edit("unsaved work");
    expect(localStorage.getItem("cc-panes-editor-tabs")).not.toContain("unsaved work");
    act(() => useEditorTabsStore.getState().selectTab(b));
    await waitFor(() => expect(screen.getByTestId("buffer-editor")).toHaveValue("disk:/project/b.ts"));
    expect(io.mounted).toBe(1);
    act(() => useEditorTabsStore.getState().selectTab(a));
    expect(screen.getByTestId("buffer-editor")).toHaveValue("unsaved work");
    expect(useEditorTabsStore.getState().tabs.find((tab) => tab.id === a)?.dirty).toBe(true);
    panel.unmount();
    expect(io.mounted).toBe(0);
    render(<FileEditorPanel />);
    expect(await screen.findByTestId("buffer-editor")).toHaveValue("unsaved work");
    expect(io.mounted).toBe(1);
    expect(io.read.mock.calls.filter(([path]) => path === "/project/a.ts")).toHaveLength(1);
    expect(io.write).not.toHaveBeenCalled();
  });

  it("keeps dirty text on close cancellation and releases it only after confirmed discard", async () => {
    const a = open("a");
    render(<FileEditorPanel />);
    await screen.findByTestId("buffer-editor");
    edit("unsaved work");
    fireEvent.click(closeButton("a.ts"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common:cancel") }));
    expect(screen.getByTestId("buffer-editor")).toHaveValue("unsaved work");
    expect(useEditorBuffersStore.getState().buffers[a].content).toBe("unsaved work");
    fireEvent.click(closeButton("a.ts"));
    await confirmClose();
    expect(useEditorTabsStore.getState().tabs).toHaveLength(0);
    expect(useEditorBuffersStore.getState().buffers[a]).toBeUndefined();
    act(() => { open("a"); });
    expect(await screen.findByTestId("buffer-editor")).toHaveValue("disk:/project/a.ts");
  });

  it.each<BulkCloseAction>(["closeOtherTabs", "closeTabsToLeft", "closeTabsToRight"])(
    "%s confirms the selected dirty tabs, preserves pinned buffers and excludes later tabs",
    async (action) => {
      const left = open("left");
      const anchor = open("anchor");
      const right = open("right");
      const pinned = open("pinned");
      useEditorTabsStore.getState().togglePin(pinned);
      for (const id of [left, right, pinned]) {
        useEditorTabsStore.getState().updateBuffer(id, { content: id, loaded: true });
      }
      useEditorTabsStore.getState().selectTab(anchor);
      render(<FileEditorPanel />);
      await screen.findByTestId("buffer-editor");
      await closeMenu("anchor.ts", action);
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      let later = "";
      act(() => { later = open("later"); });
      await confirmClose();
      const remaining = useEditorTabsStore.getState().tabs.map((tab) => tab.id);
      expect(remaining).toContain(pinned);
      expect(remaining).toContain(later);
      expect(useEditorBuffersStore.getState().buffers[pinned].content).toBe(pinned);
      const closed = action === "closeTabsToLeft" ? [left] : action === "closeTabsToRight" ? [right] : [left, right];
      for (const id of closed) {
        expect(remaining).not.toContain(id);
        expect(useEditorBuffersStore.getState().buffers[id]).toBeUndefined();
      }
    },
  );

  it("retains conflict metadata when returning to a dirty buffer", async () => {
    const a = open("a");
    const b = open("b");
    useEditorTabsStore.getState().selectTab(a);
    render(<FileEditorPanel />);
    await screen.findByTestId("buffer-editor");
    edit("unsaved work");
    act(() => useEditorTabsStore.getState().selectTab(b));
    await screen.findByTestId("buffer-editor");
    act(() => useEditorTabsStore.getState().selectTab(a));
    io.info.mockResolvedValue({ size: 20, modified: "external-change" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByText("save-buffer"));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(io.write).not.toHaveBeenCalled();
    expect(screen.getByTestId("buffer-editor")).toHaveValue("unsaved work");
    confirm.mockRestore();
  });

  it("keeps identical remote paths on different SSH machines in separate buffers", async () => {
    const store = useEditorTabsStore.getState();
    store.openRemoteFile("one", "one", "/srv/main.ts", "one.ts", 20);
    const one = useEditorTabsStore.getState().activeTabId!;
    store.openRemoteFile("two", "two", "/srv/main.ts", "two.ts", 20);
    const two = useEditorTabsStore.getState().activeTabId!;
    store.selectTab(one);
    render(<FileEditorPanel />);
    await screen.findByTestId("buffer-editor");
    edit("one unsaved");
    act(() => store.selectTab(two));
    await waitFor(() => expect(screen.getByTestId("buffer-editor")).toHaveValue("two"));
    act(() => store.selectTab(one));
    expect(screen.getByTestId("buffer-editor")).toHaveValue("one unsaved");
    fireEvent.click(screen.getByText("save-buffer"));
    await waitFor(() => expect(io.remoteWrite).toHaveBeenCalledWith("one", "/srv/main.ts", "one unsaved"));
    expect(io.write).not.toHaveBeenCalled();
  });

  it("does not resurrect a closed buffer when an in-flight save finishes", async () => {
    const a = open("a");
    let finish!: () => void;
    io.write.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<FileEditorPanel />);
    await screen.findByTestId("buffer-editor");
    edit("pending save");
    fireEvent.click(screen.getByText("save-buffer"));
    await waitFor(() => expect(io.write).toHaveBeenCalled());
    fireEvent.click(closeButton("a.ts"));
    await confirmClose();
    await act(async () => { finish(); });
    expect(useEditorBuffersStore.getState().buffers[a]).toBeUndefined();
    expect(useEditorTabsStore.getState().tabs).toHaveLength(0);
  });

  it("applies a save completed after remount without clearing edits made after that save began", async () => {
    const a = open("a");
    const b = open("b");
    useEditorTabsStore.getState().selectTab(a);
    let finish!: () => void;
    io.write.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<FileEditorPanel />);
    await screen.findByTestId("buffer-editor");
    edit("saving this version");
    fireEvent.click(screen.getByText("save-buffer"));
    await waitFor(() => expect(io.write).toHaveBeenCalled());
    act(() => useEditorTabsStore.getState().selectTab(b));
    await screen.findByTestId("buffer-editor");
    act(() => useEditorTabsStore.getState().selectTab(a));
    edit("newer unsaved version");
    await act(async () => { finish(); });
    expect(screen.getByTestId("buffer-editor")).toHaveValue("newer unsaved version");
    expect(useEditorBuffersStore.getState().buffers[a].originalContent).toBe("saving this version");
    expect(useEditorTabsStore.getState().tabs.find((tab) => tab.id === a)?.dirty).toBe(true);
  });
});
