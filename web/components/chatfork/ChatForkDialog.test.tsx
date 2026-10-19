import "@/i18n";
import i18n from "i18next";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChatForkDialog from "./ChatForkDialog";
const t = (key: "forkSameDirectory" | "forkWorktree" | "forkChat") =>
  i18n.t(key, { ns: "panes" });
describe("ChatForkDialog", () => {
  it("offers both modes and submits the selected worktree mode", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    render(<ChatForkDialog open onOpenChange={close} onFork={create} />);
    const user = userEvent.setup();
    expect(
      screen.getByRole("radio", { name: t("forkSameDirectory") }),
    ).toBeChecked();
    await user.click(screen.getByRole("radio", { name: t("forkWorktree") }));
    await user.click(screen.getByRole("button", { name: t("forkChat") }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("worktree"));
    expect(close).toHaveBeenCalledWith(false);
  });
  it("shows failure and retains the choice for retry", async () => {
    const close = vi.fn();
    render(
      <ChatForkDialog
        open
        onOpenChange={close}
        onFork={vi.fn().mockRejectedValue(new Error("not a git repository"))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: t("forkChat") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not a git repository",
    );
    expect(close).not.toHaveBeenCalled();
  });
});
