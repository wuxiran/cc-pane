import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateWebglGlyphModel,
  notifyAtlasStructureChanged,
} from "./terminalAtlasRefresh";

describe("invalidateWebglGlyphModel", () => {
  it("clears the glyph model via the private _clearModel(true) hook", () => {
    const clearModel = vi.fn();
    const cleared = invalidateWebglGlyphModel({
      _renderer: { _clearModel: clearModel },
    });
    expect(cleared).toBe(true);
    expect(clearModel).toHaveBeenCalledWith(true);
  });

  it("falls back to the public renderer.clear() when _clearModel is missing", () => {
    const clear = vi.fn();
    const cleared = invalidateWebglGlyphModel({ _renderer: { clear } });
    expect(cleared).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("returns false when the addon has no renderer", () => {
    expect(invalidateWebglGlyphModel(null)).toBe(false);
    expect(invalidateWebglGlyphModel({})).toBe(false);
  });

  it("returns false when the private hook throws", () => {
    const cleared = invalidateWebglGlyphModel({
      _renderer: {
        _clearModel: () => {
          throw new Error("minified shape changed");
        },
      },
    });
    expect(cleared).toBe(false);
  });
});

describe("notifyAtlasStructureChanged", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces multiple notifications into one animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    notifyAtlasStructureChanged();
    notifyAtlasStructureChanged();
    expect(frames).toHaveLength(1);
    frames[0](0);
  });
});
