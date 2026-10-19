import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePetPointerGesture } from "./usePetPointerGesture";
const native = vi.hoisted(() => ({ position: vi.fn(), scale: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ outerPosition: native.position, scaleFactor: native.scale }) }));
const clicked = vi.fn();
function Harness() {
  const { interacting, ...handlers } = usePetPointerGesture(clicked, vi.fn());
  return <button {...handlers} data-active={interacting}>pet</button>;
}
beforeEach(() => {
  vi.clearAllMocks();
  native.position.mockResolvedValue({ x: 400, y: 200 });
  native.scale.mockResolvedValue(2);
  vi.mocked(invoke).mockResolvedValue(undefined);
});
describe("pet dragging", () => {
  it("moves the full CSS distance at 200% DPI and saves the final pointer coordinate", async () => {
    render(<Harness />);
    const pet = screen.getByText("pet");
    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(pet, { pointerId: 1, screenX: 150, screenY: 160 });
    fireEvent.pointerUp(pet, { pointerId: 1, screenX: 160, screenY: 170 });
    fireEvent.click(pet);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("move_ccchan_window", { x: 260, y: 170, persist: true }));
    // Coalescing may skip intermediate pointer moves; only the final position is persisted.
    expect(vi.mocked(invoke).mock.calls.filter(([, args]) => (args as { persist?: boolean })?.persist === true)).toHaveLength(1);
    expect(clicked).not.toHaveBeenCalled();
    expect(pet).toHaveAttribute("data-active", "false");
  });
  it("ignores a delayed position lookup after the gesture is cancelled", async () => {
    let resolve!: (value: { x: number; y: number }) => void;
    native.position.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness />);
    const pet = screen.getByText("pet");
    fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(pet, { pointerId: 1, screenX: 150, screenY: 160 });
    fireEvent.pointerCancel(pet, { pointerId: 1 });
    await act(async () => { resolve({ x: 400, y: 200 }); });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("treats pointer-up plus the native click as one click", async () => {
    render(<Harness />);
    const pet = screen.getByText("pet");
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 10, screenY: 10 });
      fireEvent.pointerUp(pet, { pointerId: 1, screenX: 10, screenY: 10 });
      fireEvent.click(pet);
    });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});
