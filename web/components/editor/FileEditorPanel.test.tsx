import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useEditorTabsStore, type EditorTab } from "@/stores/useEditorTabsStore";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useFileTreeStore } from "@/stores/useFileTreeStore";
import FileEditorPanel from "./FileEditorPanel";

// EditorView 依赖 Monaco/文件系统，用桩替代
vi.mock("./EditorView", () => ({
  default: ({ filePath }: { filePath: string }) => (
    <div data-testid="editor-view">{filePath}</div>
  ),
}));

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

function makeTab(id: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id,
    title: `${id}.ts`,
    filePath: `/proj/src/${id}.ts`,
    projectPath: "/proj",
    dirty: false,
    ...overrides,
  } as EditorTab;
}

function setupStore(tabs: EditorTab[], activeTabId: string | null = tabs[0]?.id ?? null) {
  useEditorTabsStore.setState({ tabs, activeTabId });
}

function tabElement(title: string): HTMLElement {
  return screen.getByText(title).closest("div[draggable]") as HTMLElement;
}

function tabTitles(): string[] {
  return Array.from(document.querySelectorAll("div[draggable]"), (el) => el.textContent ?? "");
}

function activeFile(): string | null {
  return screen.queryByTestId("editor-view")?.textContent ?? null;
}

const closeLabel = i18n.t("panes:closeTab", { defaultValue: "Close Tab" });

function closeControl(title: string): HTMLElement | undefined {
  return within(tabElement(title)).queryByRole("button", { name: closeLabel }) ?? undefined;
}

function makeDataTransfer() {
  const data: Record<string, string> = {};
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (type: string, val: string) => {
      data[type] = val;
    },
    getData: (type: string) => data[type],
  };
}

describe("FileEditorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the empty state when no tabs are open", () => {
    setupStore([]);
    render(<FileEditorPanel />);
    expect(
      screen.getByText(i18n.t("sidebar:noOpenFiles", { defaultValue: "No open files" }))
    ).toBeInTheDocument();
    expect(screen.queryByTestId("editor-view")).not.toBeInTheDocument();
  });

  it.each([
    ["C:/root.txt", "C:/"],
    ["//server/share/root.txt", "//server/share"],
  ])("reveals %s in its actual root directory", async (filePath, parent) => {
    const navigateTo = vi.fn();
    const revealFile = vi.fn();
    useFileBrowserStore.setState({ navigateTo });
    useFileTreeStore.setState({ revealFile });
    setupStore([makeTab("root", { filePath })]);
    render(<FileEditorPanel />);
    fireEvent.contextMenu(tabElement("root.ts"));
    fireEvent.click(await screen.findByText(i18n.t("panes:revealInExplorer")));
    expect(navigateTo).toHaveBeenCalledWith(parent);
    expect(revealFile).toHaveBeenCalledWith(parent, filePath);
  });

  it("renders tabs and mounts the editor for the active tab", () => {
    setupStore([makeTab("a"), makeTab("b")], "b");
    render(<FileEditorPanel />);
    expect(tabTitles()).toEqual(["a.ts", "b.ts"]);
    expect(activeFile()).toBe("/proj/src/b.ts");
  });

  it("selects a tab on click", async () => {
    const user = userEvent.setup();
    setupStore([makeTab("a"), makeTab("b")], "a");
    render(<FileEditorPanel />);
    await user.click(screen.getByText("b.ts"));
    expect(activeFile()).toBe("/proj/src/b.ts");
  });

  it("closes a tab from its close control without selecting it", async () => {
    const user = userEvent.setup();
    setupStore([makeTab("a"), makeTab("b")], "a");
    render(<FileEditorPanel />);
    await user.click(closeControl("b.ts")!);
    expect(tabTitles()).toEqual(["a.ts"]);
    expect(activeFile()).toBe("/proj/src/a.ts");
  });

  it("hides the close control and shows the pin marker for pinned tabs", () => {
    setupStore([makeTab("a", { pinned: true } as Partial<EditorTab>)]);
    render(<FileEditorPanel />);
    expect(closeControl("a.ts")).toBeUndefined();
    // Pin 图标无 aria，只能按 lucide 类名定位
    expect(tabElement("a.ts").querySelector("svg.lucide-pin")).not.toBeNull();
  });

  it("marks dirty tabs with a dot", () => {
    setupStore([makeTab("a", { dirty: true })]);
    render(<FileEditorPanel />);
    expect(tabElement("a.ts").textContent).toContain("●");
  });

  it("reorders tabs via drag and drop", () => {
    setupStore([makeTab("a"), makeTab("b"), makeTab("c")], "a");
    render(<FileEditorPanel />);

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(tabElement("a.ts"), { dataTransfer });
    fireEvent.dragOver(tabElement("c.ts"), { dataTransfer });
    fireEvent.drop(tabElement("c.ts"), { dataTransfer });
    expect(tabTitles()).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  describe("context menu", () => {
    async function openTabMenu(title: string) {
      fireEvent.contextMenu(tabElement(title));
      await waitFor(() => {
        expect(screen.getByRole("menu")).toBeInTheDocument();
      });
    }

    function menuItem(key: string): HTMLElement {
      return screen.getByText(i18n.t(`panes:${key}` as never)).closest("[role='menuitem']") as HTMLElement;
    }

    it("pins from the menu", async () => {
      setupStore([makeTab("a"), makeTab("b")], "a");
      render(<FileEditorPanel />);
      await openTabMenu("a.ts");
      fireEvent.click(menuItem("pinTab"));
      expect(closeControl("a.ts")).toBeUndefined();
      expect(useEditorTabsStore.getState().tabs[0].pinned).toBe(true);
    });

    it("disables close-to-left when nothing closable exists on the left", async () => {
      setupStore([makeTab("a"), makeTab("b")], "a");
      render(<FileEditorPanel />);
      await openTabMenu("a.ts");

      expect(menuItem("closeTabsToLeft")).toHaveAttribute("aria-disabled", "true");
      const closeRight = menuItem("closeTabsToRight");
      expect(closeRight).not.toHaveAttribute("aria-disabled", "true");
      fireEvent.click(closeRight);
      expect(tabTitles()).toEqual(["a.ts"]);
    });

    it("closes other tabs from the menu", async () => {
      setupStore([makeTab("a"), makeTab("b"), makeTab("c")], "b");
      render(<FileEditorPanel />);
      await openTabMenu("b.ts");
      fireEvent.click(menuItem("closeOtherTabs"));
      expect(tabTitles()).toEqual(["b.ts"]);
    });

    it("omits the close item for pinned tabs", async () => {
      setupStore([makeTab("a", { pinned: true } as Partial<EditorTab>), makeTab("b")], "a");
      render(<FileEditorPanel />);
      await openTabMenu("a.ts");
      expect(screen.queryByText(closeLabel)).not.toBeInTheDocument();
    });
  });

  describe("keyboard accessibility", () => {
    it("tab body is Tab-focusable and selects on Enter/Space", async () => {
      const user = userEvent.setup();
      setupStore([makeTab("a"), makeTab("b")], "a");
      render(<FileEditorPanel />);

      // 第一个 tab 是标签栏首个 Tab 停留点
      await user.tab();
      const tabA = screen.getByRole("button", { name: /a\.ts/ });
      expect(tabA).toHaveFocus();

      const tabB = screen.getByRole("button", { name: /b\.ts/ });
      expect(tabB).toHaveAttribute("tabindex", "0");
      fireEvent.keyDown(tabB, { key: "Enter" });
      expect(activeFile()).toBe("/proj/src/b.ts");
      fireEvent.keyDown(tabA, { key: " " });
      expect(activeFile()).toBe("/proj/src/a.ts");
    });

    it("close control is focusable and closes on Enter/Space without selecting", () => {
      setupStore([makeTab("a"), makeTab("b"), makeTab("c")], "a");
      render(<FileEditorPanel />);

      const closeB = closeControl("b.ts")!;
      expect(closeB).toHaveAttribute("tabindex", "0");
      closeB.focus();
      expect(closeB).toHaveFocus();
      fireEvent.keyDown(closeB, { key: "Enter" });
      expect(tabTitles()).toEqual(["a.ts", "c.ts"]);
      expect(activeFile()).toBe("/proj/src/a.ts");

      fireEvent.keyDown(closeControl("c.ts")!, { key: " " });
      expect(tabTitles()).toEqual(["a.ts"]);
      expect(activeFile()).toBe("/proj/src/a.ts");
    });
  });
});
