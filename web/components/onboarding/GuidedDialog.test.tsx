import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GuidedDialog from "./GuidedDialog";

describe("GuidedDialog", () => {
  it("does not mount dialog content while closed", () => {
    render(
      <GuidedDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Welcome"
        description="Start here"
        visual={<div>Preview</div>}
        footer={<button type="button">Continue</button>}
      >
        <div>Guide content</div>
      </GuidedDialog>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders accessible copy, content, visual and actions in separate regions", () => {
    render(
      <GuidedDialog
        open
        onOpenChange={vi.fn()}
        title="Welcome"
        description="Start here"
        visual={<div>Preview</div>}
        footer={<button type="button">Continue</button>}
      >
        <div>Guide content</div>
      </GuidedDialog>,
    );

    expect(screen.getByRole("dialog", { name: "Welcome" })).toBeVisible();
    expect(screen.getByText("Start here")).toBeVisible();
    expect(screen.getByTestId("guided-dialog-copy")).toHaveTextContent("Guide content");
    expect(screen.getByTestId("guided-dialog-visual")).toHaveTextContent("Preview");
    expect(screen.getByTestId("guided-dialog-footer")).toContainElement(
      screen.getByRole("button", { name: "Continue" }),
    );
  });
});
