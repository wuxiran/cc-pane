import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppToaster, TOAST_MAX_VISIBLE, getToasts, toast } from "./toast";

describe("AppToaster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => toast.dismiss());
    vi.useRealTimers();
  });

  it("shows a toast and removes it after its duration", () => {
    render(<AppToaster />);
    act(() => {
      toast.success("saved", { duration: 1000 });
    });
    expect(screen.getByText("saved")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("saved")).toBeNull();
  });

  it("stays out of document flow even without a stylesheet", () => {
    render(<AppToaster offset={40} />);
    const region = screen.getByTestId("app-toaster");
    expect(region.style.position).toBe("fixed");
    expect(region.style.bottom).toBe("40px");
    expect(region.parentElement).toBe(document.body);
  });

  it("updates in place when the same id is reused", () => {
    render(<AppToaster />);
    act(() => {
      toast.info("first", { id: "job" });
      toast.error("second", { id: "job" });
    });
    expect(getToasts()).toHaveLength(1);
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByTestId("app-toast").getAttribute("data-kind")).toBe("error");
  });

  it("uses alert semantics for errors and status for confirmations", () => {
    render(<AppToaster />);
    act(() => {
      toast.success("ok");
      toast.error("boom");
    });
    const [ok, boom] = screen.getAllByTestId("app-toast");
    expect(ok.getAttribute("role")).toBe("status");
    expect(boom.getAttribute("role")).toBe("alert");
  });

  it("pauses the timer while hovered", () => {
    render(<AppToaster />);
    act(() => {
      toast("hover me", { duration: 1000 });
    });
    const row = screen.getByTestId("app-toast");
    fireEvent.mouseEnter(row);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("hover me")).toBeTruthy();
    fireEvent.mouseLeave(row);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("hover me")).toBeNull();
  });

  it("runs the action and dismisses", () => {
    const onClick = vi.fn();
    render(<AppToaster />);
    act(() => {
      toast.info("copied", { action: { label: "Undo", onClick } });
    });
    fireEvent.click(screen.getByText("Undo"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("keeps only the newest toasts", () => {
    render(<AppToaster />);
    act(() => {
      for (let index = 0; index < TOAST_MAX_VISIBLE + 2; index += 1) toast(`t${index}`);
    });
    expect(getToasts()).toHaveLength(TOAST_MAX_VISIBLE);
    expect(screen.queryByText("t0")).toBeNull();
    expect(screen.getByText(`t${TOAST_MAX_VISIBLE + 1}`)).toBeTruthy();
  });
});
