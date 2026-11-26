import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "@/types";
import NotificationSection from "./NotificationSection";

function createValue(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    enabled: true,
    onExit: false,
    onWaitingInput: true,
    onlyWhenUnfocused: false,
    ...overrides,
  };
}

describe("NotificationSection", () => {
  it("renders four switches reflecting the current value", () => {
    render(<NotificationSection value={createValue()} onChange={vi.fn()} />);

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    expect(switches[0]).toBeChecked(); // enabled
    expect(switches[1]).not.toBeChecked(); // onExit
    expect(switches[2]).toBeChecked(); // onWaitingInput
    expect(switches[3]).not.toBeChecked(); // onlyWhenUnfocused
  });

  it.each<[number, keyof NotificationSettings]>([
    [0, "enabled"],
    [1, "onExit"],
  ])("emits an immutable update when toggling switch %i (%s)", async (index, key) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = createValue();
    const before = value[key];
    render(<NotificationSection value={value} onChange={onChange} />);

    await user.click(screen.getAllByRole("switch")[index]);

    expect(onChange).toHaveBeenCalledWith({ ...value, [key]: !before });
    // 原对象不被修改
    expect(value[key]).toBe(before);
  });

  it("disables sub options when notifications are disabled", () => {
    render(<NotificationSection value={createValue({ enabled: false })} onChange={vi.fn()} />);

    const switches = screen.getAllByRole("switch");
    expect(switches[0]).not.toBeDisabled();
    expect(switches[1]).toBeDisabled();
    expect(switches[2]).toBeDisabled();
    expect(switches[3]).toBeDisabled();
  });
});
