import { describe, expect, it } from "vitest";
import { positionsEqual } from "./usePaneGeometryRegistry";

const position = { x: 10, y: 20, width: 100, height: 50 };

describe("usePaneGeometryRegistry", () => {
  it("recognizes equivalent measurements without replacing the position map", () => {
    const previous = { node: position };
    const next = { node: { ...position } };

    expect(positionsEqual(previous, next)).toBe(true);
    expect(positionsEqual(previous, { node: { ...position, x: 11 } })).toBe(false);
    expect(positionsEqual(previous, {})).toBe(false);
  });
});
