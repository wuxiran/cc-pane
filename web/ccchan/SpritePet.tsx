import type { MouseEventHandler, PointerEventHandler } from "react";
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
  onPointerCancel?: PointerEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onPointerMove?: PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: PointerEventHandler<HTMLButtonElement>;
}

export function SpritePet({
  pet,
  state,
  size = 60,
  title,
  onClick,
  onMouseDown,
  onContextMenu,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: SpritePetProps) {
  const { cellW, cellH, cols, rows } = pet.atlas;
  const animation = getPetAnimation(pet, state);
  const frame = usePetAnimationFrame(pet, state) % Math.max(1, animation.frames);
  const scale = size / Math.max(cellW, cellH);
  const left = (size - cellW * scale) / 2;
  const top = (size - cellH * scale) / 2;

  return (
    <button
      type="button"
      aria-label={title ?? pet.displayName}
      title={title ?? pet.displayName}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="block border-0 bg-transparent p-0 outline-none select-none"
      style={{
        width: size,
        height: size,
        touchAction: "none",
      }}
    >
      <span aria-hidden="true" style={{
        display: "block",
        pointerEvents: "none",
        width: cellW * scale,
        height: cellH * scale,
        marginLeft: left,
        marginTop: top,
        backgroundImage: `url(${pet.spritesheetUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${cols * cellW * scale}px ${rows * cellH * scale}px`,
        backgroundPosition: `${-(frame + (animation.colOffset ?? 0)) * cellW * scale}px ${-animation.row * cellH * scale}px`,
        imageRendering: "pixelated",
      }} />
    </button>
  );
}
