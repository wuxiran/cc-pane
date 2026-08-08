import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TodoResizeHandle from "./TodoResizeHandle";

describe("TodoResizeHandle", () => {
  it("拖动时按鼠标横向位移回调", () => {
    const onResize = vi.fn();
    render(<TodoResizeHandle label="调整面板" onResize={onResize} />);

    fireEvent.pointerDown(screen.getByRole("separator"), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 118 });
    fireEvent.pointerMove(window, { clientX: 112 });
    fireEvent.pointerUp(window);

    expect(onResize).toHaveBeenNthCalledWith(1, 18);
    expect(onResize).toHaveBeenNthCalledWith(2, -6);
  });

  it("方向键每次微调 12px", () => {
    const onResize = vi.fn();
    render(<TodoResizeHandle label="调整面板" onResize={onResize} />);
    const handle = screen.getByRole("separator");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(onResize).toHaveBeenNthCalledWith(1, -12);
    expect(onResize).toHaveBeenNthCalledWith(2, 12);
  });
});
