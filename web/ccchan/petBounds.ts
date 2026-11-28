// 角色可见包围盒：精灵格子四周常有大片透明，按格子整体缩放会让角色显得很小。
// 加载精灵时离屏扫一遍 alpha，取所有动画帧可见像素的并集，按它来缩放与对齐
// （并集而非逐帧：换动画时角色不会忽大忽小）。读不到像素（canvas 被跨域污染、
// 测试环境无 canvas）时退回按格中心的固定比例裁剪。
import { useEffect, useState } from "react";
import type { PetMeta } from "./types";

export interface PetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ALPHA_THRESHOLD = 12;
const cache = new Map<string, Promise<PetBounds | null>>();

/** 固定比例裁剪：大多数 Codex 风格精灵角色占格子中下部约 3/4。 */
export function fallbackBounds(atlas: PetMeta["atlas"]): PetBounds {
  if (atlas.cellW <= 64 && atlas.cellH <= 64) {
    return { x: 0, y: 0, width: atlas.cellW, height: atlas.cellH };
  }
  return {
    x: atlas.cellW * 0.12,
    y: atlas.cellH * 0.12,
    width: atlas.cellW * 0.76,
    height: atlas.cellH * 0.84,
  };
}

interface Cell {
  col: number;
  row: number;
}

export function usedCells(pet: PetMeta): Cell[] {
  const seen = new Set<string>();
  const cells: Cell[] = [];
  for (const animation of Object.values(pet.animations)) {
    for (let frame = 0; frame < animation.frames; frame += 1) {
      const col = (animation.colOffset ?? 0) + frame;
      const key = `${col}:${animation.row}`;
      if (col >= pet.atlas.cols || animation.row >= pet.atlas.rows || seen.has(key)) continue;
      seen.add(key);
      cells.push({ col, row: animation.row });
    }
  }
  return cells;
}

/** 在整张图的 RGBA 数据里，求若干格子内可见像素的并集（格子内坐标）。 */
export function scanAlphaBounds(
  data: Uint8ClampedArray,
  imageWidth: number,
  atlas: PetMeta["atlas"],
  cells: readonly Cell[],
): PetBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (const cell of cells) {
    const originX = cell.col * atlas.cellW;
    const originY = cell.row * atlas.cellH;
    for (let y = 0; y < atlas.cellH; y += 1) {
      const rowStart = ((originY + y) * imageWidth + originX) * 4;
      for (let x = 0; x < atlas.cellW; x += 1) {
        if ((data[rowStart + x * 4 + 3] ?? 0) <= ALPHA_THRESHOLD) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function scanImage(pet: PetMeta): Promise<PetBounds | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      resolve(null);
      return;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        resolve(scanAlphaBounds(data, canvas.width, pet.atlas, usedCells(pet)));
      } catch (error) {
        console.warn("[ccchan] sprite bounds scan failed; using center crop:", error);
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = pet.spritesheetUrl;
  });
}

export function loadPetBounds(pet: PetMeta): Promise<PetBounds | null> {
  const key = `${pet.spritesheetUrl}|${pet.atlas.cellW}x${pet.atlas.cellH}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = scanImage(pet);
    cache.set(key, pending);
  }
  return pending;
}

export function usePetBounds(pet: PetMeta): PetBounds {
  const [scanned, setScanned] = useState<{ id: string; bounds: PetBounds } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPetBounds(pet).then((bounds) => {
      if (alive && bounds) setScanned({ id: pet.spritesheetUrl, bounds });
    });
    return () => {
      alive = false;
    };
  }, [pet]);
  return scanned?.id === pet.spritesheetUrl ? scanned.bounds : fallbackBounds(pet.atlas);
}

export interface SpriteFit {
  scale: number;
  /** 精灵格子左上角相对显示框的偏移。 */
  left: number;
  top: number;
  /** 角色可见区域（显示框内坐标），用作点击命中区域。 */
  visible: PetBounds;
}

/** 把包围盒放进 size×size 的框：水平居中、脚踩框底。 */
export function fitSprite(bounds: PetBounds, size: number): SpriteFit {
  const longest = Math.max(1, bounds.width, bounds.height);
  const scale = size / longest;
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  const visibleX = (size - width) / 2;
  const visibleY = size - height;
  return {
    scale,
    left: visibleX - bounds.x * scale,
    top: visibleY - bounds.y * scale,
    visible: { x: visibleX, y: visibleY, width, height },
  };
}
