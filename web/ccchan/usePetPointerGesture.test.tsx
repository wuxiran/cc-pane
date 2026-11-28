import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePetPointerGesture } from "./usePetPointerGesture";

const startDragging = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging }) }));

function Harness({ onClick }: { onClick: () => void }) {
  const gesture = usePetPointerGesture(onClick);
  return <button type="button" {...gesture}>pet</button>;
}

beforeEach(() => startDragging.mockClear());

it("treats a still press as a click", () => {
  const onClick = vi.fn();
  render(<Harness onClick={onClick}/>);
  const pet = screen.getByRole("button");
  fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 10, screenY: 10 });
  fireEvent.pointerUp(pet, { button: 0, pointerId: 1, screenX: 11, screenY: 10 });
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(startDragging).not.toHaveBeenCalled();
});

it("hands a moving press to native dragging and does not click", () => {
  const onClick = vi.fn();
  render(<Harness onClick={onClick}/>);
  const pet = screen.getByRole("button");
  fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 10, screenY: 10 });
  fireEvent.pointerMove(pet, { pointerId: 1, screenX: 30, screenY: 10 });
  fireEvent.pointerUp(pet, { button: 0, pointerId: 1, screenX: 30, screenY: 10 });
  expect(startDragging).toHaveBeenCalledTimes(1);
  expect(onClick).not.toHaveBeenCalled();
});

it("ignores the right button (the context menu handles it)", () => {
  const onClick = vi.fn();
  render(<Harness onClick={onClick} />);
  const pet = screen.getByRole("button");
  fireEvent.pointerDown(pet, { button: 2, pointerId: 2 });
  fireEvent.pointerUp(pet, { button: 2, pointerId: 2 });
  expect(onClick).not.toHaveBeenCalled();
});
