import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FALLBACK_PET } from "@/stores/useCCChanStore";
import { SpritePet } from "./SpritePet";
import { fallbackBounds, fitSprite, scanAlphaBounds, usedCells } from "./petBounds";

const ATLAS = { cellW: 192, cellH: 208, cols: 8, rows: 9 };

describe("SpritePet", () => {
  it("crops transparent margins so the character fills the box, feet on the bottom", () => {
    render(<SpritePet pet={{ ...FALLBACK_PET, atlas: ATLAS }} status="idle" size={120} />);
    const button = screen.getByRole("button");
    const sprite = button.querySelector("span")!;
    expect(button).toHaveStyle({ width: "120px", height: "120px" });
    // 按包围盒放大：格子本身比显示框大。
    expect(parseFloat(sprite.style.height)).toBeGreaterThan(120);
  });

  it("does not schedule animation work for a single-frame pet", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<SpritePet pet={FALLBACK_PET} status="idle" />);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it("scales illustrated pets smoothly and keeps hard edges only for pixel-art pets", () => {
    const { rerender } = render(<SpritePet pet={FALLBACK_PET} status="idle" size={120} />);
    expect(screen.getByRole("button").querySelector("span")!.style.imageRendering).toBe("auto");
    rerender(<SpritePet pet={{ ...FALLBACK_PET, pixelArt: true }} status="idle" size={120} />);
    expect(screen.getByRole("button").querySelector("span")!.style.imageRendering).toBe("pixelated");
  });
});

describe("petBounds", () => {
  it("unions visible pixels across used cells", () => {
    const atlas = { cellW: 4, cellH: 4, cols: 2, rows: 1 };
    const width = 8;
    const data = new Uint8ClampedArray(width * 4 * 4);
    const setAlpha = (x: number, y: number) => { data[(y * width + x) * 4 + 3] = 255; };
    setAlpha(1, 1); // cell 0 local (1,1)
    setAlpha(6, 3); // cell 1 local (2,3)
    const bounds = scanAlphaBounds(data, width, atlas, [{ col: 0, row: 0 }, { col: 1, row: 0 }]);
    expect(bounds).toEqual({ x: 1, y: 1, width: 2, height: 3 });
    expect(scanAlphaBounds(new Uint8ClampedArray(width * 16), width, atlas, [{ col: 0, row: 0 }])).toBeNull();
  });

  it("lists each animation frame cell once", () => {
    const cells = usedCells({
      ...FALLBACK_PET,
      atlas: ATLAS,
      animations: { idle: { row: 0, frames: 2, fps: 1 }, again: { row: 0, frames: 3, fps: 1 } },
    });
    expect(cells).toHaveLength(3);
  });

  it("fits bounds bottom-centered and falls back to a centre crop", () => {
    const fit = fitSprite({ x: 20, y: 40, width: 100, height: 160 }, 120);
    expect(fit.scale).toBeCloseTo(0.75);
    expect(fit.visible.y + fit.visible.height).toBeCloseTo(120);
    expect(fit.visible.x * 2 + fit.visible.width).toBeCloseTo(120);
    const crop = fallbackBounds(ATLAS);
    expect(crop.width).toBeLessThan(ATLAS.cellW);
    expect(fallbackBounds({ cellW: 64, cellH: 64, cols: 1, rows: 1 }).width).toBe(64);
  });
});
