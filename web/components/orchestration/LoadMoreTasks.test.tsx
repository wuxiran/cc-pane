import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoadMoreTasks from "./LoadMoreTasks";
afterEach(() => vi.useRealTimers());
describe("task pagination feedback", () => {
  it("disables immediately, delays the spinner, and reserves a fixed footprint", () => {
    vi.useFakeTimers(); const load = vi.fn();
    const view = render(<LoadMoreTasks hasMore loading={false} onLoad={load} />);
    const button = screen.getByRole("button", { name: "加载更多任务" }); expect(button).toHaveClass("w-44");
    view.rerender(<LoadMoreTasks hasMore loading onLoad={load} />);
    expect(button).toBeDisabled(); expect(view.container.querySelector("svg")).toBeNull();
    act(() => vi.advanceTimersByTime(199)); expect(view.container.querySelector("svg")).toBeNull();
    act(() => vi.advanceTimersByTime(1)); expect(view.container.querySelector("svg")).not.toBeNull();
    expect(button).toHaveClass("w-44");
  });
  it("keeps a readable error and retry action even when no first page was loaded", () => {
    const retry = vi.fn(); const view = render(<LoadMoreTasks hasMore={false} loading={false} error="permission denied" onLoad={vi.fn()} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("任务列表加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" })); expect(retry).toHaveBeenCalledOnce();
    view.rerender(<LoadMoreTasks hasMore={false} loading error="permission denied" onLoad={vi.fn()} onRetry={retry} />);
    expect(screen.getByRole("alert")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "重试" })).toBeDisabled();
  });
});
