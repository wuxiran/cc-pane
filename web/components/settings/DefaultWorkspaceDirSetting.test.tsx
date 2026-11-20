import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";
import DefaultWorkspaceDirSetting from "./DefaultWorkspaceDirSetting";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
const pickDirectory = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => pickDirectory(...args) }));
const toastOk = vi.fn();
const toastErr = vi.fn();
vi.mock("@/lib/feedback", () => ({ toastOk: (...args: unknown[]) => toastOk(...args), toastErr: (...args: unknown[]) => toastErr(...args) }));

const updateWorkspacePath = vi.fn(async () => {});
const defaultWorkspace = { id: "d", name: "default", createdAt: "", projects: [], isDefault: true, path: "/data/workspaces/default" } as Workspace;
const other = { id: "o", name: "other", createdAt: "", projects: [], path: "/repos/other" } as Workspace;

describe("DefaultWorkspaceDirSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspacesStore.setState({ workspaces: [other, defaultWorkspace], updateWorkspacePath } as never);
  });

  it("shows where the default workspace lives", () => {
    render(<DefaultWorkspaceDirSetting />);
    expect(screen.getByTestId("default-workspace-dir")).toHaveTextContent("/data/workspaces/default");
  });

  it("moves the default workspace to the folder the user picks", async () => {
    pickDirectory.mockResolvedValue("/somewhere/else");
    render(<DefaultWorkspaceDirSetting />);
    fireEvent.click(screen.getByText("browse"));
    await waitFor(() => expect(updateWorkspacePath).toHaveBeenCalledWith("default", "/somewhere/else"));
    expect(toastOk).toHaveBeenCalled();
  });

  it("does nothing when the picker is cancelled or the same folder is chosen", async () => {
    pickDirectory.mockResolvedValueOnce(null).mockResolvedValueOnce("/data/workspaces/default");
    render(<DefaultWorkspaceDirSetting />);
    fireEvent.click(screen.getByText("browse"));
    fireEvent.click(screen.getByText("browse"));
    await Promise.resolve();
    await Promise.resolve();
    expect(updateWorkspacePath).not.toHaveBeenCalled();
  });

  it("reports a failure and keeps the old path", async () => {
    pickDirectory.mockResolvedValue("/readonly");
    updateWorkspacePath.mockRejectedValueOnce(new Error("denied"));
    render(<DefaultWorkspaceDirSetting />);
    fireEvent.click(screen.getByText("browse"));
    await waitFor(() => expect(toastErr).toHaveBeenCalled());
    expect(screen.getByTestId("default-workspace-dir")).toHaveTextContent("/data/workspaces/default");
  });

  it("renders nothing when there is no default workspace", () => {
    useWorkspacesStore.setState({ workspaces: [other] } as never);
    const { container } = render(<DefaultWorkspaceDirSetting />);
    expect(container).toBeEmptyDOMElement();
  });
});
