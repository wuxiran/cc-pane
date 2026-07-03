import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileTreeStore } from "@/stores";
import FileExplorerView from "./FileExplorerView";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

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

const PROJECT = "/proj";

function setupStore() {
  const actions = {
    loadDirectory: vi.fn().mockResolvedValue(undefined),
    loadGitStatuses: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    createFile: vi.fn().mockResolvedValue(undefined),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    toggleShowHidden: vi.fn(),
  };
  useFileTreeStore.setState({
    trees: {},
    gitStatuses: {},
    showHidden: false,
    ...actions,
  });
  return actions;
}

describe("FileExplorerView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the toolbar and the (loading) file tree", () => {
    setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("refreshes the tree from the toolbar", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);
    await user.click(screen.getAllByRole("button")[0]);
    expect(actions.refresh).toHaveBeenCalledWith(PROJECT);
  });

  it("toggles hidden files from the toolbar", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);
    await user.click(screen.getAllByRole("button")[3]);
    expect(actions.toggleShowHidden).toHaveBeenCalled();
  });

  it("creates a new file through the dialog", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);

    await user.click(screen.getAllByRole("button")[1]);
    expect(await screen.findByText("New File")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("filename.ext"), "  hello.ts  ");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(actions.createFile).toHaveBeenCalledWith(PROJECT, "hello.ts", PROJECT);
    });
    expect(toast.success).toHaveBeenCalledWith("Created: hello.ts");
  });

  it("creates a new folder via Enter in the dialog input", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);

    await user.click(screen.getAllByRole("button")[2]);
    expect(await screen.findByText("New Folder")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("folder-name"), "docs{Enter}");
    await waitFor(() => {
      expect(actions.createDirectory).toHaveBeenCalledWith(PROJECT, "docs", PROJECT);
    });
  });

  it("does nothing when submitting an empty name", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);

    await user.click(screen.getAllByRole("button")[1]);
    await screen.findByText("New File");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(actions.createFile).not.toHaveBeenCalled();
  });

  it("can cancel the dialog without creating anything", async () => {
    const user = userEvent.setup();
    const actions = setupStore();
    render(<FileExplorerView projectPath={PROJECT} />);

    await user.click(screen.getAllByRole("button")[1]);
    await screen.findByText("New File");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByText("New File")).not.toBeInTheDocument();
    });
    expect(actions.createFile).not.toHaveBeenCalled();
  });
});
