import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import VersionListSidebar from "./VersionListSidebar";
import type { FileVersion } from "@/services";

const V1: FileVersion = {
  id: "v-1",
  filePath: "src/app.ts",
  hash: "h1",
  size: 128,
  createdAt: new Date().toISOString(),
  isDeleted: false,
  branch: "",
} as FileVersion;

function renderSidebar(overrides: Record<string, unknown> = {}) {
  const props = {
    loading: false,
    filteredVersions: [V1],
    selectedVersion: null,
    fileBranches: [],
    selectVersion: vi.fn(),
    openLabelDialog: vi.fn(),
    getVersionLabels: () => [],
    ...overrides,
  };
  render(<VersionListSidebar {...props} />);
  return props;
}

describe("VersionListSidebar keyboard accessibility", () => {
  it("版本项可 Tab 聚焦并带 focus-visible 焦点环", async () => {
    const user = userEvent.setup();
    renderSidebar();

    const item = screen.getByRole("button");
    expect(item).toHaveAttribute("tabindex", "0");
    expect(item.className).toContain("focus-visible:outline-none");
    expect(item.className).toContain("focus-visible:ring-2");
    expect(item.className).toContain("focus-visible:ring-[var(--app-accent)]");

    await user.tab();
    expect(item).toHaveFocus();
  });

  it("Enter/Space 触发版本选中", () => {
    const props = renderSidebar();
    const item = screen.getByRole("button");

    item.focus();
    fireEvent.keyDown(item, { key: "Enter" });
    expect(props.selectVersion).toHaveBeenCalledTimes(1);
    expect(props.selectVersion).toHaveBeenCalledWith(V1);

    fireEvent.keyDown(item, { key: " " });
    expect(props.selectVersion).toHaveBeenCalledTimes(2);
  });

  it("右键打开标签对话框的行为不变", () => {
    const props = renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button"));
    expect(props.openLabelDialog).toHaveBeenCalledWith(V1);
  });
});
