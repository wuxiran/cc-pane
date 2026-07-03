import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useMemoryStore } from "@/stores";
import type { Memory } from "@/types";
import MemoryManager from "./MemoryManager";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

const PROJECT = "D:/proj";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m-1",
    title: "Prefer immutable data",
    content: "Always use immutable updates in stores",
    scope: "project",
    category: "preference",
    importance: 4,
    workspace_name: null,
    project_path: PROJECT,
    session_id: null,
    tags: ["zustand", "immer"],
    source: "user",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    accessed_at: "2026-01-01T00:00:00Z",
    access_count: 0,
    user_id: null,
    sync_status: "local_only",
    sync_version: 0,
    is_deleted: false,
    ...overrides,
  };
}

function setupStore(overrides: Record<string, unknown> = {}) {
  const actions = {
    search: vi.fn().mockResolvedValue(undefined),
    loadList: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(makeMemory()),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(),
    setSearchText: vi.fn(),
    setSelectedScope: vi.fn(),
    reset: vi.fn(),
  };
  useMemoryStore.setState({
    memories: [],
    total: 0,
    loading: false,
    selectedMemory: null,
    searchText: "",
    selectedScope: null,
    ...actions,
    ...overrides,
  });
  return actions;
}

describe("MemoryManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the project memory list on mount and resets on unmount", () => {
    const actions = setupStore();
    const { unmount } = render(<MemoryManager projectPath={PROJECT} />);
    expect(actions.loadList).toHaveBeenCalledWith({ projectPath: PROJECT });
    unmount();
    expect(actions.reset).toHaveBeenCalled();
  });

  it("shows the empty state when there are no memories", () => {
    setupStore();
    render(<MemoryManager projectPath={PROJECT} />);
    expect(screen.getByText(i18n.t("dialogs:noMemory"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("dialogs:selectOrCreateMemory"))).toBeInTheDocument();
  });

  it("renders memory rows with title, category badge and content preview", () => {
    setupStore({ memories: [makeMemory()], total: 1 });
    render(<MemoryManager projectPath={PROJECT} />);
    expect(screen.getByText("Prefer immutable data")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("dialogs:categoryPreference"))).toBeInTheDocument();
    expect(screen.getByText(/Always use immutable/)).toBeInTheDocument();
    // total badge
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("selects a memory when its row is clicked", async () => {
    const user = userEvent.setup();
    const memory = makeMemory();
    const actions = setupStore({ memories: [memory], total: 1 });
    render(<MemoryManager projectPath={PROJECT} />);
    await user.click(screen.getByText("Prefer immutable data"));
    expect(actions.select).toHaveBeenCalledWith(memory);
  });

  it("fills the editor form from the selected memory", () => {
    setupStore({ memories: [makeMemory()], selectedMemory: makeMemory() });
    render(<MemoryManager projectPath={PROJECT} />);
    expect(screen.getAllByDisplayValue("Prefer immutable data").length).toBeGreaterThan(0);
    expect(
      screen.getByDisplayValue("Always use immutable updates in stores")
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("zustand, immer")).toBeInTheDocument();
  });

  it("filters by scope via the badge row", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<MemoryManager projectPath={PROJECT} />);
    await user.click(screen.getByText(i18n.t("dialogs:memoryProject")));
    expect(actions.setSelectedScope).toHaveBeenCalledWith("project");
  });

  it("debounces search text into a search call", async () => {
    const actions = setupStore({ searchText: "immutable" });
    render(<MemoryManager projectPath={PROJECT} />);
    await waitFor(() => {
      expect(actions.search).toHaveBeenCalledWith({
        search: "immutable",
        project_path: PROJECT,
        scope: undefined,
      });
    });
  });

  it("rejects creating a memory without a title", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<MemoryManager projectPath={PROJECT} />);

    // 顶栏 + 按钮进入新建
    const header = screen.getByText("Memory").closest("div")!
      .parentElement as HTMLElement;
    await user.click(header.querySelector("button")!);

    // 标题为空时保存按钮 disabled，Ctrl+S 走 handleSave 弹错误
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(toast.error).toHaveBeenCalledWith(i18n.t("notifications:titleRequired"));
    expect(actions.store).not.toHaveBeenCalled();
  });

  it("creates a project-scoped memory with parsed tags", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<MemoryManager projectPath={PROJECT} />);

    const header = screen.getByText("Memory").closest("div")!
      .parentElement as HTMLElement;
    await user.click(header.querySelector("button")!);

    await user.type(
      screen.getByPlaceholderText(i18n.t("dialogs:memoryTitlePlaceholder")),
      "New fact"
    );
    await user.type(
      screen.getByPlaceholderText(i18n.t("dialogs:memoryTagsPlaceholder")),
      " a , b ,, "
    );
    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("common:create")) })
    );

    await waitFor(() => {
      expect(actions.store).toHaveBeenCalledWith({
        title: "New fact",
        content: "",
        scope: "project",
        category: "fact",
        importance: 3,
        project_path: PROJECT,
        tags: ["a", "b"],
        source: "user",
      });
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t("notifications:memoryCreated"));
  });

  it("updates the selected memory instead of creating", async () => {
    const user = userEvent.setup();
    const actions = setupStore({ selectedMemory: makeMemory() });
    render(<MemoryManager projectPath={PROJECT} />);

    await user.click(
      screen.getByRole("button", { name: new RegExp(`${i18n.t("common:save")}$`) })
    );
    await waitFor(() => {
      expect(actions.update).toHaveBeenCalledWith("m-1", {
        title: "Prefer immutable data",
        content: "Always use immutable updates in stores",
        category: "preference",
        importance: 4,
        tags: ["zustand", "immer"],
      });
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t("notifications:memoryUpdated"));
  });

  it("deletes a memory from the row action without selecting it", async () => {
    const user = userEvent.setup();
    const actions = setupStore({ memories: [makeMemory()], total: 1 });
    render(<MemoryManager projectPath={PROJECT} />);

    const row = screen
      .getByText("Prefer immutable data")
      .closest("div[class*='group']") as HTMLElement;
    await user.click(row.querySelector("button")!);

    await waitFor(() => {
      expect(actions.remove).toHaveBeenCalledWith("m-1");
    });
    expect(toast.success).toHaveBeenCalledWith(i18n.t("notifications:memoryDeleted"));
    expect(actions.select).not.toHaveBeenCalled();
  });

  it("surfaces store failures as an error toast", async () => {
    const user = userEvent.setup();
    const actions = setupStore({ selectedMemory: makeMemory() });
    actions.update.mockRejectedValue(new Error("db locked"));
    render(<MemoryManager projectPath={PROJECT} />);

    await user.click(
      screen.getByRole("button", { name: new RegExp(`${i18n.t("common:save")}$`) })
    );
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });
});
