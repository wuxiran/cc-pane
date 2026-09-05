import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";

function TestAlertDialog(props: {
  onAction?: () => void;
  onCancel?: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={props.onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onAction}>
            Continue
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe("AlertDialog", () => {
  it("opens with the alertdialog role and labelled content", async () => {
    const user = userEvent.setup();
    render(<TestAlertDialog />);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Are you sure?");
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="alert-dialog-overlay"]'),
    ).toBeInTheDocument();
  });

  it("closes on Cancel and fires the cancel handler", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<TestAlertDialog onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("closes on Action and fires the action handler", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<TestAlertDialog onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onAction).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<TestAlertDialog />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("does not close when the overlay is clicked", async () => {
    const user = userEvent.setup();
    render(<TestAlertDialog />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const overlay = document.querySelector(
      '[data-slot="alert-dialog-overlay"]',
    );
    expect(overlay).toBeInTheDocument();
    await user.click(overlay as HTMLElement);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
