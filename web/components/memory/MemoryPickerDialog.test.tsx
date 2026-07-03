import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { Memory } from "@/types";
import MemoryPickerDialog from "./MemoryPickerDialog";

vi.mock("@/services/memoryService", () => ({
  memoryService: {
    list: vi.fn(),
    search: vi.fn(),
  },
}));

const { memoryService } = await import("@/services/memoryService");
const listMock = memoryService.list as ReturnType<typeof vi.fn>;
const searchMock = memoryService.search as ReturnType<typeof vi.fn>;

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

const PROJECT = "D:/proj";

function makeMemory(id: string, title: string): Memory {
  return {
    id,
    title,
    content: `content of ${title}`,
    scope: "project",
    category: "fact",
    importance: 2,
    workspace_name: null,
    project_path: PROJECT,
    session_id: null,
    tags: [],
    source: "user",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    accessed_at: "2026-01-01T00:00:00Z",
    access_count: 0,
    user_id: null,
    sync_status: "local_only",
    sync_version: 0,
    is_deleted: false,
  };
}

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <MemoryPickerDialog
      open={open}
      onOpenChange={onOpenChange}
      projectPath={PROJECT}
      onConfirm={onConfirm}
    />
  );
  return { onOpenChange, onConfirm };
}

describe("MemoryPickerDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({
      items: [makeMemory("m-1", "First"), makeMemory("m-2", "Second")],
      total: 2,
    });
    searchMock.mockResolvedValue({ items: [makeMemory("m-3", "Found")], total: 1 });
  });

  it("loads memories when opened", async () => {
    renderDialog();
    await screen.findByText("First");
    expect(listMock).toHaveBeenCalledWith({
      projectPath: PROJECT,
      scope: undefined,
      limit: 50,
    });
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    renderDialog(false);
    expect(screen.queryByText(i18n.t("dialogs:memoryPickerTitle"))).not.toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("shows the empty state when no memories exist", async () => {
    listMock.mockResolvedValue({ items: [], total: 0 });
    renderDialog();
    expect(
      await screen.findByText(i18n.t("dialogs:memoryPickerNoMemory"))
    ).toBeInTheDocument();
  });

  it("keeps confirm disabled until a memory is checked", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("First");

    const confirmBtn = screen.getByRole("button", { name: i18n.t("common:confirm") });
    expect(confirmBtn).toBeDisabled();

    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(confirmBtn).toBeEnabled();
  });

  it("confirms with the selected memory ids and closes", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onConfirm } = renderDialog();
    await screen.findByText("First");

    const [first, second] = screen.getAllByRole("checkbox");
    await user.click(first);
    await user.click(second);
    // 再取消第一个，验证 toggle
    await user.click(first);

    await user.click(screen.getByRole("button", { name: i18n.t("common:confirm") }));
    expect(onConfirm).toHaveBeenCalledWith(["m-2"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("switches to search mode after typing (debounced)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("First");

    await user.type(
      screen.getByPlaceholderText(i18n.t("dialogs:memoryPickerSearch")),
      "found"
    );
    await waitFor(() => {
      expect(searchMock).toHaveBeenCalledWith({
        search: "found",
        project_path: PROJECT,
        scope: undefined,
        limit: 50,
      });
    });
    expect(await screen.findByText("Found")).toBeInTheDocument();
  });

  it("filters by scope from the badge row", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("First");
    listMock.mockClear();

    await user.click(screen.getByText(i18n.t("dialogs:memoryGlobal")));
    await waitFor(() => {
      expect(listMock).toHaveBeenCalledWith({
        projectPath: PROJECT,
        scope: "global",
        limit: 50,
      });
    });
  });

  it("cancel closes without confirming", async () => {
    const user = userEvent.setup();
    const { onOpenChange, onConfirm } = renderDialog();
    await screen.findByText("First");
    await user.click(screen.getByRole("button", { name: i18n.t("common:cancel") }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
