import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { screenshotService } from "@/services";
import type { ScreenshotSettings } from "@/types";
import ScreenshotSection from "./ScreenshotSection";

vi.mock("@/services/screenshotService", () => ({
  screenshotService: {
    updateShortcut: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function createValue(overrides: Partial<ScreenshotSettings> = {}): ScreenshotSettings {
  return {
    shortcut: "Ctrl+Shift+S",
    retentionDays: 7,
    ...overrides,
  };
}

describe("ScreenshotSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the current shortcut as a button and switches to capture mode on click", async () => {
    const user = userEvent.setup();
    render(<ScreenshotSection value={createValue()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Shift+S" }));

    // 进入编辑态后显示只读捕获输入框
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Ctrl+Shift+S" })).not.toBeInTheDocument();
  });

  it("captures a key combo and persists it via the screenshot service on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(screenshotService.updateShortcut).mockResolvedValue(undefined as never);
    render(<ScreenshotSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Shift+S" }));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "a", ctrlKey: true, altKey: true });
    expect(input).toHaveValue("Ctrl+Alt+A");

    fireEvent.blur(input);

    await waitFor(() =>
      expect(screenshotService.updateShortcut).toHaveBeenCalledWith("Ctrl+Shift+S", "Ctrl+Alt+A"),
    );
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shortcut: "Ctrl+Alt+A" }));
    expect(toast.success).toHaveBeenCalled();
  });

  it.each([
    { ctrlKey: false, expected: "Super+Shift+S" },
    { ctrlKey: true, expected: "Ctrl+Super+Shift+S" },
  ])("records Command separately from Control: $expected", async ({ ctrlKey, expected }) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(screenshotService.updateShortcut).mockResolvedValue(undefined as never);
    render(<ScreenshotSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Shift+S" }));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "s", metaKey: true, ctrlKey, shiftKey: true });
    expect(input).toHaveValue(expected);
    fireEvent.blur(input);

    await waitFor(() =>
      expect(screenshotService.updateShortcut).toHaveBeenCalledWith("Ctrl+Shift+S", expected),
    );
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shortcut: expected }));
  });

  it("ignores standalone modifier keys while capturing", async () => {
    const user = userEvent.setup();
    render(<ScreenshotSection value={createValue()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Shift+S" }));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Meta", metaKey: true });
    fireEvent.keyDown(input, { key: "Shift", shiftKey: true });

    // 仍显示提示文案，没有捕获任何组合键
    expect(screenshotService.updateShortcut).not.toHaveBeenCalled();
    fireEvent.blur(input);
    // 无 pending 组合键时 blur 只退出编辑态
    expect(screen.getByRole("button", { name: "Ctrl+Shift+S" })).toBeInTheDocument();
  });

  it("cancels editing with Escape without persisting", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScreenshotSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Shift+S" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

    expect(screen.getByRole("button", { name: "Ctrl+Shift+S" })).toBeInTheDocument();
    expect(screenshotService.updateShortcut).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the old shortcut and shows an error toast when the update conflicts", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(screenshotService.updateShortcut).mockRejectedValue(new Error("conflict"));
    render(<ScreenshotSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Shift+S" }));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "x", ctrlKey: true });
    fireEvent.blur(input);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    // 退出编辑态，按钮仍显示旧快捷键
    expect(screen.getByRole("button", { name: "Ctrl+Shift+S" })).toBeInTheDocument();
  });

  it("emits parsed retention days and falls back to 0 for invalid input", () => {
    const onChange = vi.fn();
    render(<ScreenshotSection value={createValue()} onChange={onChange} />);

    const retention = screen.getByDisplayValue("7");
    fireEvent.change(retention, { target: { value: "30" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ retentionDays: 30 }));

    fireEvent.change(retention, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ retentionDays: 0 }));
  });
});
