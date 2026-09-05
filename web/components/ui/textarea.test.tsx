import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Textarea } from "./textarea";

describe("Textarea", () => {
  it("renders a textbox with placeholder", () => {
    render(<Textarea placeholder="Type here" />);

    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Type here",
    );
  });

  it("accepts user input", async () => {
    const user = userEvent.setup();
    render(<Textarea />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "hello world");

    expect(textarea).toHaveValue("hello world");
  });

  it("supports disabled state", () => {
    render(<Textarea disabled />);

    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("forwards aria-invalid for form errors", () => {
    render(<Textarea aria-invalid="true" />);

    expect(screen.getByRole("textbox")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("merges custom className", () => {
    render(<Textarea className="min-h-32" />);

    expect(screen.getByRole("textbox")).toHaveClass("min-h-32");
  });
});
