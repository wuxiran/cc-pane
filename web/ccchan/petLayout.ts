// 宠物窗口固定布局。窗口尺寸公式必须与 src-tauri/src/services/ccchan_window.rs
// 的 `window_size_for` 同步：只随角色大小变，不随交互模式变。
// 自上而下：气泡区 → 悬停控件条 → 角色框（脚踩窗口底，四周小边距）。
// 透明部分由后端命中测试放行点击，所以窗口可以比角色宽。
import type { PetBounds } from "./petBounds";

export const BUBBLE_AREA = 120;
export const TOOLBAR_AREA = 30;
export const PET_PADDING = 8;
export const MIN_WINDOW_WIDTH = 280;

export interface PetLayout {
  width: number;
  height: number;
  petSize: number;
  /** 角色框左上角。 */
  petX: number;
  petY: number;
  toolbarY: number;
  bubbleBottom: number;
}

export function getPetLayout(petSize: number): PetLayout {
  const width = Math.max(petSize + PET_PADDING * 2, MIN_WINDOW_WIDTH);
  const height = petSize + PET_PADDING + TOOLBAR_AREA + BUBBLE_AREA;
  const petY = BUBBLE_AREA + TOOLBAR_AREA;
  return {
    width,
    height,
    petSize,
    petX: (width - petSize) / 2,
    petY,
    toolbarY: BUBBLE_AREA,
    bubbleBottom: BUBBLE_AREA,
  };
}

export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 可点击区域：角色可见包围盒（略放宽）+ 悬停时的控件条 + 显示中的气泡。 */
export function hitRegions(
  layout: PetLayout,
  visible: PetBounds,
  options: { toolbar: boolean; bubble: HitRect | null },
): HitRect[] {
  const slack = 6;
  const regions: HitRect[] = [
    {
      x: layout.petX + visible.x - slack,
      y: layout.petY + visible.y - slack,
      width: visible.width + slack * 2,
      height: visible.height + slack * 2,
    },
  ];
  if (options.toolbar) {
    regions.push({ x: 0, y: layout.toolbarY, width: layout.width, height: TOOLBAR_AREA + visible.y + slack });
  }
  if (options.bubble) regions.push(options.bubble);
  return regions.map((rect) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }));
}
