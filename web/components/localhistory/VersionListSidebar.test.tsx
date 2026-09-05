import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeVersion(id: string): FileVersion {
  return { ...V1, id } as FileVersion;
}

/** jsdom 无布局：虚拟化器读 offsetHeight，滚动容器给 600px 视口、行给 56px */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList?.contains("app-scrollbar")) return 600;
    if (this.hasAttribute?.("data-index")) return 56;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 260);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("VersionListSidebar virtualization", () => {
  it("长历史只渲染可视窗口内的版本行", () => {
    const versions = Array.from({ length: 200 }, (_, i) => makeVersion(`v-${i}`));
    renderSidebar({ filteredVersions: versions });

    const rendered = screen.getAllByRole("button");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(40);
    expect(rendered.length).toBeLessThan(versions.length);
  });

  it("滚动到底部后末尾版本可见", () => {
    const versions = Array.from({ length: 200 }, (_, i) => makeVersion(`v-${i}`));
    const props = renderSidebar({ filteredVersions: versions });

    const scroller = screen.getAllByRole("button")[0].closest(".app-scrollbar") as HTMLElement;
    scroller.scrollTop = 56 * 200;
    fireEvent.scroll(scroller);

    const rendered = screen.getAllByRole("button");
    expect(rendered.length).toBeLessThan(40);
    // 末尾行已渲染：对最后一行触发键盘选中应拿到最后一个版本
    const last = rendered[rendered.length - 1];
    fireEvent.keyDown(last, { key: "Enter" });
    expect(props.selectVersion).toHaveBeenCalledWith(versions[versions.length - 1]);
  });
});
