import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Input } from "@/components/ui/input";
import { FormField } from "./form-field";

describe("FormField", () => {
  it("renders the label and the control", () => {
    render(
      <FormField label="Host">
        {({ id }) => <Input id={id} placeholder="127.0.0.1" />}
      </FormField>,
    );

    expect(screen.getByText("Host")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("127.0.0.1")).toBeInTheDocument();
  });

  it("pairs Label htmlFor with the control id", () => {
    render(
      <FormField label="Host">
        {({ id }) => <Input id={id} placeholder="127.0.0.1" />}
      </FormField>,
    );

    const label = screen.getByText("Host");
    const control = screen.getByPlaceholderText("127.0.0.1");
    expect(label).toHaveAttribute("for", control.id);
    expect(control.id).not.toBe("");
  });

  it("makes the control queryable by its label text", () => {
    render(
      <FormField label="Host">
        {({ id }) => <Input id={id} />}
      </FormField>,
    );

    expect(screen.getByLabelText("Host")).toBeInTheDocument();
  });

  it("generates unique ids for sibling fields", () => {
    render(
      <>
        <FormField label="Host">{({ id }) => <Input id={id} />}</FormField>
        <FormField label="Port">{({ id }) => <Input id={id} />}</FormField>
      </>,
    );

    expect(screen.getByLabelText("Host").id).not.toBe(screen.getByLabelText("Port").id);
  });

  it("renders hint text with a stable id for aria-describedby", () => {
    render(
      <FormField label="Host" hint="Comma separated list" hintClassName="text-[11px]">
        {({ id, hintId }) => <Input id={id} aria-describedby={hintId} />}
      </FormField>,
    );

    const hint = screen.getByText("Comma separated list");
    const control = screen.getByLabelText("Host");
    expect(hint).toHaveAttribute("id", control.getAttribute("aria-describedby"));
    expect(control.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("omits hintId when no hint is provided", () => {
    const spy = vi.fn();
    render(
      <FormField label="Host">
        {(ids) => {
          spy(ids);
          return <Input id={ids.id} />;
        }}
      </FormField>,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), labelId: expect.any(String), hintId: undefined }),
    );
  });

  it("exposes labelId so composite controls can use aria-labelledby", () => {
    render(
      <FormField label="Engine">
        {({ labelId }) => (
          <div role="group" aria-labelledby={labelId}>
            <button type="button">A</button>
          </div>
        )}
      </FormField>,
    );

    const label = screen.getByText("Engine");
    const group = screen.getByRole("group");
    expect(label).toHaveAttribute("id", group.getAttribute("aria-labelledby"));
  });

  it("keeps label click activation working for the paired control", async () => {
    const user = userEvent.setup();
    render(
      <FormField label="Host">
        {({ id }) => <Input id={id} />}
      </FormField>,
    );

    await user.click(screen.getByText("Host"));
    expect(screen.getByLabelText("Host")).toHaveFocus();
  });
});
