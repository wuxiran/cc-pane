import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import FileBrowserToolbar from "./FileBrowserToolbar";

function renderToolbar(currentPath: string) {
  const onNavigate = vi.fn();
  const onRefresh = vi.fn();
  render(
    <TooltipProvider>
      <FileBrowserToolbar currentPath={currentPath} onNavigate={onNavigate} onRefresh={onRefresh} />
    </TooltipProvider>,
  );
  return { onNavigate, onRefresh };
}

describe("FileBrowserToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a breadcrumb button per unix path segment", () => {
    renderToolbar("/home/user/proj");

    expect(screen.getByRole("button", { name: "home" })).toBeVisible();
    expect(screen.getByRole("button", { name: "user" })).toBeVisible();
    expect(screen.getByRole("button", { name: "proj" })).toBeVisible();
  });

  it("navigates to the accumulated path when clicking a breadcrumb segment", () => {
    const { onNavigate } = renderToolbar("/home/user/proj");

    fireEvent.click(screen.getByRole("button", { name: "user" }));

    expect(onNavigate).toHaveBeenCalledWith("/home/user");
  });

  it("treats a Windows drive segment as the drive root", () => {
    const { onNavigate } = renderToolbar("D:/work/repo");

    fireEvent.click(screen.getByRole("button", { name: "D:" }));

    expect(onNavigate).toHaveBeenCalledWith("D:/");
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    expect(onNavigate).toHaveBeenLastCalledWith("D:/work");
  });

  it("keeps the network share as an atomic UNC breadcrumb", () => {
    const { onNavigate } = renderToolbar("\\\\server\\share\\work\\repo");
    fireEvent.click(screen.getByRole("button", { name: "//server/share" }));
    expect(onNavigate).toHaveBeenLastCalledWith("//server/share");
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    expect(onNavigate).toHaveBeenLastCalledWith("//server/share/work");
    expect(screen.queryByRole("button", { name: "server" })).not.toBeInTheDocument();
  });

  it("shows a usable POSIX root rather than the empty-path placeholder", () => {
    const { onNavigate } = renderToolbar("/");
    fireEvent.click(screen.getByRole("button", { name: "/" }));
    expect(onNavigate).toHaveBeenCalledWith("/");
  });

  it("shows an empty-path placeholder when currentPath is empty", () => {
    renderToolbar("");

    expect(screen.getByText(/Select a directory|选择一个目录/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "home" })).not.toBeInTheDocument();
  });

  it("invokes onRefresh when the refresh button is clicked", () => {
    const { onRefresh } = renderToolbar("/home/user");

    // The refresh button is the last button (after breadcrumb segments)
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[buttons.length - 1]);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("enters edit mode on double click and confirms a new path on Enter", () => {
    const { onNavigate } = renderToolbar("/home/user");

    // Double-click the breadcrumb container (parent of the segments)
    fireEvent.doubleClick(screen.getByRole("button", { name: "home" }).closest("div")!.parentElement!);

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("/home/user");

    fireEvent.change(input, { target: { value: "/etc/hosts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledWith("/etc/hosts");
  });

  it("does not navigate when the edited path is unchanged", () => {
    const { onNavigate } = renderToolbar("/home/user");

    fireEvent.doubleClick(screen.getByRole("button", { name: "home" }).closest("div")!.parentElement!);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("cancels editing without navigating on Escape", () => {
    const { onNavigate } = renderToolbar("/home/user");

    fireEvent.doubleClick(screen.getByRole("button", { name: "home" }).closest("div")!.parentElement!);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "/somewhere/else" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onNavigate).not.toHaveBeenCalled();
    // Back to breadcrumb mode
    expect(screen.getByRole("button", { name: "home" })).toBeVisible();
  });
});
