import type { MouseEventHandler, PointerEventHandler } from "react";
import { getPetAnimation, usePetAnimationFrame } from "./petAnimation";
import { fitSprite, usePetBounds } from "./petBounds";
import type { PetStatus } from "./petStatus";
import type { PetMeta } from "./types";

interface SpritePetProps {
  pet: PetMeta;
  status: PetStatus;
  size?: number;
  title?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onPointerCancel?: PointerEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onPointerMove?: PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: PointerEventHandler<HTMLButtonElement>;
}

export function SpritePet({ pet, status, size = 60, title, ...handlers }: SpritePetProps) {
  const { cellW, cellH, cols, rows } = pet.atlas;
  const animation = getPetAnimation(pet, status);
  const frame = usePetAnimationFrame(pet, status) % Math.max(1, animation.frames);
  const fit = fitSprite(usePetBounds(pet), size);
  const scale = fit.scale;

  return (
    <button
      type="button"
      aria-label={title ?? pet.displayName}
      title={title ?? pet.displayName}
      data-pet-status={status}
      {...handlers}
      className="relative block overflow-hidden border-0 bg-transparent p-0 outline-none select-none"
      style={{ width: size, height: size, touchAction: "none" }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          pointerEvents: "none",
          left: fit.left,
          top: fit.top,
          width: cellW * scale,
          height: cellH * scale,
          backgroundImage: `url(${pet.spritesheetUrl})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${cols * cellW * scale}px ${rows * cellH * scale}px`,
          backgroundPosition: `${-(frame + (animation.colOffset ?? 0)) * cellW * scale}px ${-animation.row * cellH * scale}px`,
          // 插画风精灵非整数缩小时 pixelated 会锯齿；仅声明 pixelArt 的像素风皮肤保持硬边。
          imageRendering: pet.pixelArt ? "pixelated" : "auto",
        }}
      />
    </button>
  );
}

/** 静态首帧缩略图（Bot 头像 / 形象选择器用）。 */
export function PetThumb({ pet, size = 28 }: { pet: PetMeta; size?: number }) {
  const { cellW, cellH, cols, rows } = pet.atlas;
  const animation = getPetAnimation(pet, "idle");
  const fit = fitSprite(usePetBounds(pet), size);
  const scale = fit.scale;
  return (
    <span
      aria-hidden="true"
      className="relative block shrink-0 overflow-hidden"
      style={{ width: size, height: size }}
      data-testid="pet-thumb"
    >
      <span
        style={{
          position: "absolute",
          left: fit.left,
          top: fit.top,
          width: cellW * scale,
          height: cellH * scale,
          backgroundImage: `url(${pet.spritesheetUrl})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${cols * cellW * scale}px ${rows * cellH * scale}px`,
          backgroundPosition: `${-(animation.colOffset ?? 0) * cellW * scale}px ${-animation.row * cellH * scale}px`,
          imageRendering: pet.pixelArt ? "pixelated" : "auto",
        }}
      />
    </span>
  );
}
