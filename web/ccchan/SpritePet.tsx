import type { MouseEventHandler } from "react";
import { getPetAnimation, usePetAnimationFrame } from "./petAnimation";
import type { CCChanPetState, PetMeta } from "./types";

interface SpritePetProps {
  pet: PetMeta;
  state: CCChanPetState;
  size?: number;
  title?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
}

export function SpritePet({
  pet,
  state,
  size = 60,
  title,
  onClick,
  onMouseDown,
  onContextMenu,
}: SpritePetProps) {
  const { cellW, cellH, cols, rows } = pet.atlas;
  const animation = getPetAnimation(pet, state);
  const frame = usePetAnimationFrame(pet, state) % Math.max(1, animation.frames);
  const scale = size / cellW;

  return (
    <button
      type="button"
      data-tauri-drag-region
      aria-label={title ?? pet.displayName}
      title={title ?? pet.displayName}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className="block border-0 bg-transparent p-0 outline-none select-none"
      style={{
        width: size,
        height: cellH * scale,
        backgroundImage: `url(${pet.spritesheetUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${cols * cellW * scale}px ${rows * cellH * scale}px`,
        backgroundPosition: `${-(frame + (animation.colOffset ?? 0)) * cellW * scale}px ${-animation.row * cellH * scale}px`,
        imageRendering: "pixelated",
        cursor: "grab",
      }}
    />
  );
}
