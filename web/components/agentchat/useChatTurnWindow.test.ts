import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChatTurnWindow } from "./useChatTurnWindow";

const turns = (count: number, prefix = "turn-") => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));

describe("chat turn pagination while reading history", () => {
  it("keeps the oldest rendered turn when new turns arrive", () => {
    const original = turns(100);
    const { result, rerender } = renderHook(({ items, reading }) => useChatTurnWindow(items, reading), {
      initialProps: { items: original, reading: true },
    });
    const grown = turns(103);
    rerender({ items: grown, reading: true });
    expect(grown.slice(-result.current[0])[0].id).toBe("turn-40");
    expect(result.current[0]).toBe(63);
  });
  it("keeps ordinary follow-latest pagination bounded", () => {
    const { result, rerender } = renderHook(({ items }) => useChatTurnWindow(items, false), {
      initialProps: { items: turns(100) },
    });
    rerender({ items: turns(103) });
    expect(result.current[0]).toBe(60);
  });
  it("preserves explicit earlier-page reveals and does not reveal a prepended older page", () => {
    const original = turns(160);
    const { result, rerender } = renderHook(({ items }) => useChatTurnWindow(items, true), {
      initialProps: { items: original },
    });
    act(() => result.current[1]((count) => count + 60));
    expect(original.slice(-result.current[0])[0].id).toBe("turn-40");
    const prepended = [...turns(20, "older-"), ...original];
    rerender({ items: prepended });
    expect(result.current[0]).toBe(120);
    expect(prepended.slice(-result.current[0])[0].id).toBe("turn-40");
    const grown = [...prepended, { id: "new-reply" }];
    rerender({ items: grown });
    expect(grown.slice(-result.current[0])[0].id).toBe("turn-40");
  });
  it("does not expand the window when replay replaces ids, and preserves a later manual reveal", () => {
    const { result, rerender } = renderHook(({ items }) => useChatTurnWindow(items, true), {
      initialProps: { items: turns(100) },
    });
    rerender({ items: turns(150, "replayed-") });
    expect(result.current[0]).toBe(60);
    act(() => result.current[1]((count) => count + 60));
    rerender({ items: turns(151, "replayed-") });
    expect(result.current[0]).toBe(121);
  });
});
