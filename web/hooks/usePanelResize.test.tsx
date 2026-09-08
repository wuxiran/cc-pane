import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePanelResize } from "./usePanelResize";

afterEach(cleanup);
function Harness({ commit, collapse }: { commit: (n: number) => void; collapse: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const resize = usePanelResize({ element: ref, width: 300, min: 200, max: 500, onCommit: commit, onCollapse: collapse });
  return <div ref={ref} data-testid="panel" style={{ width: 300 }}><div data-testid="handle" onPointerDown={resize} /></div>;
}
function pointer(target: Element | Document, type: string, clientX: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX }));
}
it("commits the last pointer position once and collapses past the threshold", () => {
  const commit = vi.fn(), collapse = vi.fn(); render(<Harness commit={commit} collapse={collapse} />);
  pointer(screen.getByTestId("handle"), "pointerdown", 300);
  pointer(document, "pointermove", 450);
  pointer(document, "pointerup", 450);
  expect(commit).toHaveBeenCalledExactlyOnceWith(450);
  pointer(screen.getByTestId("handle"), "pointerdown", 300);
  pointer(document, "pointermove", 150);
  pointer(document, "pointerup", 150);
  expect(collapse).toHaveBeenCalledOnce();
  expect(document.body.style.cursor).toBe("");
});
it("cancellation and unmount restore width and release global drag state", () => {
  const commit = vi.fn(), collapse = vi.fn(); const result = render(<Harness commit={commit} collapse={collapse} />);
  pointer(screen.getByTestId("handle"), "pointerdown", 300);
  pointer(document, "pointermove", 100);
  pointer(document, "pointercancel", 100);
  expect(screen.getByTestId("panel").style.width).toBe("300px");
  expect(commit).not.toHaveBeenCalled(); expect(collapse).not.toHaveBeenCalled();
  pointer(screen.getByTestId("handle"), "pointerdown", 300); result.unmount();
  expect(document.body.style.cursor).toBe("");
});
