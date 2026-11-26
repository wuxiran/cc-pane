import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateWebglGlyphModel,
  notifyAtlasStructureChanged,
} from "./terminalAtlasRefresh";

describe("invalidateWebglGlyphModel", () => {
  it("busts the skip cache via _clearModel(false) and never calls renderer.clear()", () => {
    // clear() 会在下一帧前把 GPU 绑定的双缓冲清零；只能用 _clearModel(false) 让 UV 重建。
    const clearModel = vi.fn();
    const clear = vi.fn();
    const cleared = invalidateWebglGlyphModel({
      _renderer: { _clearModel: clearModel, clear },
    });
    expect(cleared).toBe(true);
    expect(clearModel).toHaveBeenCalledWith(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it("returns false when _clearModel is missing instead of falling back to clear()", () => {
    const clear = vi.fn();
    const cleared = invalidateWebglGlyphModel({ _renderer: { clear } });
    expect(cleared).toBe(false);
    expect(clear).not.toHaveBeenCalled();
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
