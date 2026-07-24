import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types";
import ExplorerFilesSection from "./ExplorerFilesSection";

vi.mock("@/components/filetree", () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => <div data-testid="file-tree">{rootPath}</div>,
}));

vi.mock("@/components/filetree/FileSearchView", () => ({
  default: ({ rootPath, children }: { rootPath: string; children: React.ReactNode }) => (
    <div data-testid="file-search" data-root-path={rootPath}>{children}</div>
  ),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace",
  createdAt: "2026-07-25T00:00:00Z",
  projects: [
    { id: "alpha", path: "/workspace/alpha" },
    { id: "beta", path: "/workspace/beta" },
  ],
};

describe("ExplorerFilesSection", () => {
  it("uses the selected project as the shared search root", () => {
    render(<ExplorerFilesSection workspace={workspace} selectedProjectId="beta" />);

    expect(screen.getByTestId("file-search")).toHaveAttribute("data-root-path", "/workspace/beta");
    expect(screen.getByTestId("file-tree")).toHaveTextContent("/workspace/beta");
  });

  it("falls back to the first project when no selected project is available", () => {
    render(<ExplorerFilesSection workspace={workspace} selectedProjectId="removed" />);

    expect(screen.getByTestId("file-search")).toHaveAttribute("data-root-path", "/workspace/alpha");
  });
});
