import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/components/ui/toast";
import type { ShortcutSettings } from "@/types";
import ShortcutsSection from "./ShortcutsSection";

vi.mock("@/components/ui/toast", () => ({
  toast: {
    warning: vi.fn(),
  },
}));

function createValue(bindings: Record<string, string>): ShortcutSettings {
  return { bindings };
}

describe("ShortcutsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
  });

  it("renders one row per binding with its formatted combo", () => {
    render(
      <ShortcutsSection
        value={createValue({ "new-tab": "Ctrl+T", "close-tab": "Ctrl+W" })}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Ctrl+T" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ctrl+W" })).toBeInTheDocument();
  });

  it("rebinds a shortcut after clicking its combo and pressing a new key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ShortcutsSection value={createValue({ "new-tab": "Ctrl+T" })} onChange={onChange} />,
    );

    await user.click(screen.getByRole("button", { name: "Ctrl+T" }));
    fireEvent.keyDown(screen.getByRole("button"), { key: "n", ctrlKey: true, shiftKey: true });

    expect(onChange).toHaveBeenCalledWith({ bindings: { "new-tab": "Ctrl+Shift+N" } });
  });

  it("cancels editing with Escape without emitting a change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ShortcutsSection value={createValue({ "new-tab": "Ctrl+T" })} onChange={onChange} />,
    );

    await user.click(screen.getByRole("button", { name: "Ctrl+T" }));
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ctrl+T" })).toBeInTheDocument();
  });

  it("warns and keeps editing when the new combo conflicts with another action", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ShortcutsSection
        value={createValue({ "new-tab": "Ctrl+T", "close-tab": "Ctrl+W" })}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ctrl+T" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Ctrl+W" }), {
      key: "w",
      ctrlKey: true,
    });

    expect(toast.warning).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores key presses when no binding is being edited", () => {
    const onChange = vi.fn();
    render(
      <ShortcutsSection value={createValue({ "new-tab": "Ctrl+T" })} onChange={onChange} />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Ctrl+T" }), {
      key: "x",
      ctrlKey: true,
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("labels switch-tab-N and switch-layout-N rows with their index", () => {
    render(
      <ShortcutsSection
        value={createValue({ "switch-tab-3": "Ctrl+3", "switch-layout-2": "Alt+2" })}
        onChange={vi.fn()}
      />,
    );

    // 参数化文案里必须包含序号
    const rows = document.querySelectorAll("span");
    const texts = Array.from(rows).map((el) => el.textContent);
    expect(texts.some((text) => text?.includes("3"))).toBe(true);
    expect(texts.some((text) => text?.includes("2"))).toBe(true);
  });
});
