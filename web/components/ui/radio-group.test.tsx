import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup, RadioGroupItem } from "./radio-group";

function TestRadioGroup(props: {
  defaultValue?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
}) {
  return (
    <RadioGroup
      aria-label="Plan"
      defaultValue={props.defaultValue}
      onValueChange={props.onValueChange}
    >
      <RadioGroupItem value="free" aria-label="Free" disabled={props.disabled} />
      <RadioGroupItem value="pro" aria-label="Pro" />
      <RadioGroupItem value="team" aria-label="Team" />
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("renders a radiogroup with radio items", () => {
    render(<TestRadioGroup />);

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("checks the default value via aria-checked", () => {
    render(<TestRadioGroup defaultValue="pro" />);

    expect(screen.getByRole("radio", { name: "Pro" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Free" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("selects an item on click", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<TestRadioGroup onValueChange={onValueChange} />);

    await user.click(screen.getByRole("radio", { name: "Team" }));

    expect(onValueChange).toHaveBeenCalledWith("team");
    expect(screen.getByRole("radio", { name: "Team" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("moves selection with arrow keys", async () => {
    render(<TestRadioGroup defaultValue="free" />);

    const free = screen.getByRole("radio", { name: "Free" });
    // focus() triggers Radix roving-focus state updates; keep it inside act
    act(() => free.focus());
    // NOTE: use fireEvent.keyDown only — userEvent dispatches keyup
    // synchronously, which resets Radix's isArrowKeyPressed flag before its
    // deferred (setTimeout) focus move, so the follow-up check never fires.
    fireEvent.keyDown(free, { key: "ArrowDown" });
    // flush Radix's deferred focus move inside act()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const pro = screen.getByRole("radio", { name: "Pro" });
    expect(pro).toHaveAttribute("aria-checked", "true");
    expect(pro).toHaveFocus();
  });

  it("does not select a disabled item", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<TestRadioGroup disabled onValueChange={onValueChange} />);

    const free = screen.getByRole("radio", { name: "Free" });
    expect(free).toBeDisabled();
    await user.click(free);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
