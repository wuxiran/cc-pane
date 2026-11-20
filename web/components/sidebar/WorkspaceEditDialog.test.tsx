import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";
import WorkspaceEditDialog from "./WorkspaceEditDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => false }));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/components/ui/toast", () => ({ toast: { error: (...args: unknown[]) => toastError(...args), success: (...args: unknown[]) => toastSuccess(...args) } }));

const workspace = {
  id: "w1", name: "cc-pane", createdAt: "", path: "/repos/main",
  projects: [
    { id: "a", path: "/repos/tools" },
    { id: "b", path: "/repos/main" },
    { id: "z", path: "/repos/old", archivedAt: "2026-01-01T00:00:00Z" },
  ],
} as Workspace;

const actions = {
  updateWorkspaceAlias: vi.fn(async () => {}),
  removeProject: vi.fn(async () => {}),
  addProject: vi.fn(async () => ({ id: "n", path: "" })),
  setArchived: vi.fn(async () => {}),
};

function renderDialog(onOpenChange = vi.fn()) {
  render(<WorkspaceEditDialog workspace={workspace} onOpenChange={onOpenChange} />);
  return onOpenChange;
}

describe("WorkspaceEditDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacesStore.setState(actions as never);
  });

  it("lists active folders and marks the one at the workspace root as primary", () => {
    renderDialog();
    const folders = screen.getAllByTestId("workspace-edit-folder");
    expect(folders.map((row) => row.getAttribute("title"))).toEqual(["/repos/tools", "/repos/main"]);
    expect(folders[1]).toHaveTextContent("workspaceEdit.primaryFolder");
    expect(folders[0]).not.toHaveTextContent("workspaceEdit.primaryFolder");
  });

  it("changes nothing until Save, then applies alias, removals and additions", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("/repos/new");
    const onOpenChange = renderDialog();
    fireEvent.change(screen.getByLabelText("workspaceEdit.name"), { target: { value: "Panes" } });
    fireEvent.click(screen.getByLabelText("workspaceEdit.removeFolder:tools"));
    fireEvent.click(screen.getByText("workspaceEdit.addFolder"));
    await waitFor(() => expect(screen.getAllByTestId("workspace-edit-folder")).toHaveLength(2));
    expect(actions.removeProject).not.toHaveBeenCalled();
    expect(actions.addProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(actions.updateWorkspaceAlias).toHaveBeenCalledWith("cc-pane", "Panes");
    expect(actions.removeProject).toHaveBeenCalledWith("cc-pane", "a");
    expect(actions.addProject).toHaveBeenCalledWith("cc-pane", "/repos/new");
  });

  it("cancel discards staged changes", () => {
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByLabelText("workspaceEdit.removeFolder:tools"));
    fireEvent.click(screen.getByText("cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(actions.removeProject).not.toHaveBeenCalled();
  });

  it("does not add a folder that is already in the workspace", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("/repos/main/");
    renderDialog();
    fireEvent.click(screen.getByText("workspaceEdit.addFolder"));
    await Promise.resolve();
    expect(screen.getAllByTestId("workspace-edit-folder")).toHaveLength(2);
  });

  it("asks twice before removing the workspace, and archives rather than deletes", async () => {
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByText("workspaceEdit.removeWorkspace"));
    expect(actions.setArchived).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("workspaceEdit.removeWorkspaceConfirm"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(actions.setArchived).toHaveBeenCalledWith("cc-pane", true);
  });

  it("keeps the dialog open and reports the error when saving fails", async () => {
    actions.removeProject.mockRejectedValueOnce(new Error("locked"));
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByLabelText("workspaceEdit.removeFolder:tools"));
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
