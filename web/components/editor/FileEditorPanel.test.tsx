import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useEditorTabsStore, type EditorTab } from "@/stores/useEditorTabsStore";
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
  const actions = {
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeTabsToRight: vi.fn(),
    closeTabsToLeft: vi.fn(),
    togglePin: vi.fn(),
    reorderTabs: vi.fn(),
    setDirty: vi.fn(),
  };
  useEditorTabsStore.setState({ tabs, activeTabId, ...actions });
  return actions;
}

function tabElement(title: string): HTMLElement {
  return screen.getByText(title).closest("div[draggable]") as HTMLElement;
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

  it("renders tabs and mounts the editor for the active tab", () => {
    setupStore([makeTab("a"), makeTab("b")], "b");
    render(<FileEditorPanel />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByTestId("editor-view")).toHaveTextContent("/proj/src/b.ts");
  });

  it("selects a tab on click", async () => {
    const user = userEvent.setup();
    const actions = setupStore([makeTab("a"), makeTab("b")], "a");
    render(<FileEditorPanel />);
    await user.click(screen.getByText("b.ts"));
    expect(actions.selectTab).toHaveBeenCalledWith("b");
  });

  it("closes a tab from its close control without selecting it", async () => {
    const user = userEvent.setup();
    const actions = setupStore([makeTab("a"), makeTab("b")], "a");
    render(<FileEditorPanel />);

    const closeIcon = tabElement("b.ts").querySelector("svg.lucide-x")!;
    await user.click(closeIcon.parentElement as HTMLElement);
    expect(actions.closeTab).toHaveBeenCalledWith("b");
    expect(actions.selectTab).not.toHaveBeenCalled();
  });

  it("hides the close control and shows the pin marker for pinned tabs", () => {
    setupStore([makeTab("a", { pinned: true } as Partial<EditorTab>)]);
    render(<FileEditorPanel />);
    const tab = tabElement("a.ts");
    expect(tab.querySelector("svg.lucide-x")).toBeNull();
    expect(tab.querySelector("svg.lucide-pin")).not.toBeNull();
  });

  it("marks dirty tabs with a dot", () => {
    setupStore([makeTab("a", { dirty: true })]);
    render(<FileEditorPanel />);
    expect(tabElement("a.ts").textContent).toContain("●");
  });

  it("reorders tabs via drag and drop", () => {
    const actions = setupStore([makeTab("a"), makeTab("b"), makeTab("c")], "a");
    render(<FileEditorPanel />);

    const data: Record<string, string> = {};
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, val: string) => {
        data[type] = val;
      },
      getData: (type: string) => data[type],
    };

    fireEvent.dragStart(tabElement("a.ts"), { dataTransfer });
    fireEvent.dragOver(tabElement("c.ts"), { dataTransfer });
    fireEvent.drop(tabElement("c.ts"), { dataTransfer });
    expect(actions.reorderTabs).toHaveBeenCalledWith(0, 2);
  });

  it("ignores drops onto the same position", () => {
    const actions = setupStore([makeTab("a"), makeTab("b")], "a");
    render(<FileEditorPanel />);

    const data: Record<string, string> = {};
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, val: string) => {
        data[type] = val;
      },
      getData: (type: string) => data[type],
    };
    fireEvent.dragStart(tabElement("a.ts"), { dataTransfer });
    fireEvent.drop(tabElement("a.ts"), { dataTransfer });
    expect(actions.reorderTabs).not.toHaveBeenCalled();
  });

  describe("context menu", () => {
    async function openTabMenu(title: string) {
      fireEvent.contextMenu(tabElement(title));
      await waitFor(() => {
        expect(screen.getByRole("menu")).toBeInTheDocument();
      });
    }

    it("pins and unpins from the menu", async () => {
      const actions = setupStore([makeTab("a"), makeTab("b")], "a");
      render(<FileEditorPanel />);
      await openTabMenu("a.ts");
      fireEvent.click(
        screen.getByText(i18n.t("panes:pinTab", { defaultValue: "Pin Tab" }))
      );
      expect(actions.togglePin).toHaveBeenCalledWith("a");
    });

    it("disables close-to-left when nothing closable exists on the left", async () => {
      const actions = setupStore([makeTab("a"), makeTab("b")], "a");
      render(<FileEditorPanel />);
      await openTabMenu("a.ts");

      const closeLeft = screen
        .getByText(i18n.t("panes:closeTabsToLeft", { defaultValue: "Close Tabs to the Left" }))
        .closest("[role='menuitem']") as HTMLElement;
      expect(closeLeft).toHaveAttribute("aria-disabled", "true");

      const closeRight = screen
        .getByText(i18n.t("panes:closeTabsToRight", { defaultValue: "Close Tabs to the Right" }))
        .closest("[role='menuitem']") as HTMLElement;
      expect(closeRight).not.toHaveAttribute("aria-disabled", "true");
      fireEvent.click(closeRight);
      expect(actions.closeTabsToRight).toHaveBeenCalledWith("a");
    });

    it("closes other tabs from the menu", async () => {
      const actions = setupStore([makeTab("a"), makeTab("b"), makeTab("c")], "b");
      render(<FileEditorPanel />);
      await openTabMenu("b.ts");
      fireEvent.click(
        screen.getByText(i18n.t("panes:closeOtherTabs", { defaultValue: "Close Other Tabs" }))
      );
      expect(actions.closeOtherTabs).toHaveBeenCalledWith("b");
    });

    it("omits the close item for pinned tabs", async () => {
      setupStore([makeTab("a", { pinned: true } as Partial<EditorTab>), makeTab("b")], "a");
      render(<FileEditorPanel />);
      await openTabMenu("a.ts");
      expect(
        screen.queryByText(i18n.t("panes:closeTab", { defaultValue: "Close Tab" }))
      ).not.toBeInTheDocument();
    });
  });
});
