import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SkillEditor from "./SkillEditor";

const saveLabel = () => i18n.t("common:save");
const cancelLabel = () => i18n.t("common:cancel");

describe("SkillEditor", () => {
  it("shows the name input in new mode and slash-prefixed name otherwise", () => {
    const { unmount } = render(
      <SkillEditor name="" content="" isNew onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(
      screen.getByPlaceholderText(i18n.t("dialogs:skillCommandNamePlaceholder"))
    ).toBeInTheDocument();
    unmount();

    render(
      <SkillEditor name="deploy" content="body" onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("/deploy")).toBeInTheDocument();
  });

  it("disables save while the name is blank", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SkillEditor name="" content="" isNew onSave={onSave} onCancel={vi.fn()} />);

    const saveBtn = screen.getByRole("button", { name: new RegExp(saveLabel()) });
    expect(saveBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText(i18n.t("dialogs:skillCommandNamePlaceholder")), "  my-skill  ");
    expect(saveBtn).toBeEnabled();
  });

  it("saves with trimmed name and current content", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SkillEditor name=" hi " content="" isNew onSave={onSave} onCancel={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText(i18n.t("dialogs:skillEditorPlaceholder")),
      "do the thing"
    );
    await user.click(screen.getByRole("button", { name: new RegExp(saveLabel()) }));
    expect(onSave).toHaveBeenCalledWith("hi", "do the thing");
  });

  it("saves on Ctrl+S and prevents the browser default", () => {
    const onSave = vi.fn();
    render(
      <SkillEditor name="x" content="c" onSave={onSave} onCancel={vi.fn()} />
    );
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("x", "c");
  });

  it("does not save on Ctrl+S when the name is blank", () => {
    const onSave = vi.fn();
    render(<SkillEditor name="  " content="c" isNew onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("resyncs local state when the incoming props change", () => {
    const { rerender } = render(
      <SkillEditor name="a" content="one" onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByDisplayValue("one")).toBeInTheDocument();
    rerender(<SkillEditor name="b" content="two" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByDisplayValue("two")).toBeInTheDocument();
    expect(screen.getByText("/b")).toBeInTheDocument();
  });

  it("invokes onCancel from the cancel button", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<SkillEditor name="a" content="" onSave={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: new RegExp(cancelLabel()) }));
    expect(onCancel).toHaveBeenCalled();
  });
});
