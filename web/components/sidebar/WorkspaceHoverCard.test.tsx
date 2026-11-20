import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types";
import WorkspaceHoverCard from "./WorkspaceHoverCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count !== undefined ? `${key}:${options.count}` : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("./WorkspaceEditDialog", () => ({
  default: ({ workspace }: { workspace: Workspace }) => <div data-testid="edit-dialog">{workspace.name}</div>,
}));

const workspace = {
  id: "w1", name: "cc-pane", createdAt: "",
  projects: [
    { id: "a", path: "/repos/tools" },
    { id: "b", path: "/repos/main" },
    { id: "z", path: "/repos/old", archivedAt: "2026-01-01T00:00:00Z" },
  ],
} as Workspace;

describe("WorkspaceHoverCard", () => {
  it("shows the active project folders and their full paths on hover", async () => {
    const user = userEvent.setup();
    render(<WorkspaceHoverCard workspace={workspace}><button type="button">row</button></WorkspaceHoverCard>);
    await user.hover(screen.getByText("row"));
    const card = await screen.findByTestId("workspace-hover-card");
    expect(card).toHaveTextContent("workspaceCard.projectCount:2");
    expect(card).toHaveTextContent("/repos/tools");
    expect(card).toHaveTextContent("/repos/main");
    expect(card).not.toHaveTextContent("/repos/old");
  });

  it("opens the edit dialog from the card", async () => {
    const user = userEvent.setup();
    render(<WorkspaceHoverCard workspace={workspace}><button type="button">row</button></WorkspaceHoverCard>);
    await user.hover(screen.getByText("row"));
    fireEvent.click(await screen.findByText("workspaceEdit.title"));
    expect(screen.getByTestId("edit-dialog")).toHaveTextContent("cc-pane");
  });

  it("renders only the row when disabled (system workspaces, dragging)", async () => {
    const user = userEvent.setup();
    render(<WorkspaceHoverCard workspace={workspace} disabled><button type="button">row</button></WorkspaceHoverCard>);
    await user.hover(screen.getByText("row"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.queryByTestId("workspace-hover-card")).not.toBeInTheDocument();
  });
});
