import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import EditorBreadcrumb from "./EditorBreadcrumb";

describe("EditorBreadcrumb", () => {
  const navigateTo = vi.fn();
  const toggleFilesMode = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useFileBrowserStore.setState({ navigateTo });
    useActivityBarStore.setState({ toggleFilesMode, appViewMode: "files" });
  });

  it("splits a unix path into one segment per component", () => {
    render(<EditorBreadcrumb filePath="/home/user/app.ts" />);
    expect(screen.getByRole("button", { name: "home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "user" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "app.ts" })).toBeInTheDocument();
  });

  it("normalizes backslashes and keeps the drive letter as first segment", () => {
    render(<EditorBreadcrumb filePath={"C:\\proj\\src\\main.rs"} />);
    expect(screen.getByRole("button", { name: "C:" })).toHaveAttribute("title", "C:/");
    expect(screen.getByRole("button", { name: "main.rs" })).toBeInTheDocument();
  });

  it("renders nothing for an empty path", () => {
    const { container } = render(<EditorBreadcrumb filePath="" />);
    expect(container.firstChild).toBeNull();
  });

  it("navigates when clicking a directory segment", async () => {
    const user = userEvent.setup();
    render(<EditorBreadcrumb filePath="/home/user/app.ts" />);
    await user.click(screen.getByRole("button", { name: "user" }));
    expect(navigateTo).toHaveBeenCalledWith("/home/user");
    // 已处于 files 模式，不再切换
    expect(toggleFilesMode).not.toHaveBeenCalled();
  });

  it("does not navigate when clicking the file (last) segment", async () => {
    const user = userEvent.setup();
    render(<EditorBreadcrumb filePath="/home/user/app.ts" />);
    await user.click(screen.getByRole("button", { name: "app.ts" }));
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("switches to files mode when navigating from another view mode", async () => {
    const user = userEvent.setup();
    useActivityBarStore.setState({ appViewMode: "panes" });
    render(<EditorBreadcrumb filePath="/home/user/app.ts" />);
    await user.click(screen.getByRole("button", { name: "home" }));
    expect(navigateTo).toHaveBeenCalledWith("/home");
    expect(toggleFilesMode).toHaveBeenCalledTimes(1);
  });
});
