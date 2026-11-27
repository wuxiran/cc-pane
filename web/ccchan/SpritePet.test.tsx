import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FALLBACK_PET } from "@/stores/useCCChanStore";
import { SpritePet } from "./SpritePet";
it("fits the bundled 192x208 atlas cell completely inside a square pet window", () => {
  render(<SpritePet pet={{ ...FALLBACK_PET, atlas: { cellW: 192, cellH: 208, cols: 8, rows: 9 } }} state="idle" size={120} />);
  const button = screen.getByRole("button");
  const sprite = button.querySelector("span")!;
  expect(button).toHaveStyle({ width: "120px", height: "120px" });
  expect(parseFloat(sprite.style.height)).toBeCloseTo(120);
  expect(parseFloat(sprite.style.width)).toBeLessThan(120);
  expect(parseFloat(sprite.style.marginLeft) * 2 + parseFloat(sprite.style.width)).toBeCloseTo(120);
});
it("does not schedule animation work for a single-frame pet", () => {
  const raf = vi.spyOn(window, "requestAnimationFrame");
  render(<SpritePet pet={FALLBACK_PET} state="idle" />);
  expect(raf).not.toHaveBeenCalled();
  raf.mockRestore();
});
it("scales illustrated pets smoothly and keeps hard edges only for pixel-art pets", () => {
  const { rerender } = render(<SpritePet pet={FALLBACK_PET} state="idle" size={120} />);
  expect(screen.getByRole("button").querySelector("span")!.style.imageRendering).toBe("auto");
  rerender(<SpritePet pet={{ ...FALLBACK_PET, pixelArt: true }} state="idle" size={120} />);
  expect(screen.getByRole("button").querySelector("span")!.style.imageRendering).toBe("pixelated");
});
