import { useEffect, useMemo, useState } from "react";
import type { CCChanPetState, PetMeta } from "./types";
import { startVisibleInterval } from "@/utils/visibleInterval";

const FALLBACK_ANIMATION = { row: 0, frames: 1, fps: 1 };

export function getPetAnimation(pet: PetMeta, state: CCChanPetState) {
  return pet.animations[state] ?? pet.animations.idle ?? FALLBACK_ANIMATION;
}

export function usePetAnimationFrame(pet: PetMeta, state: CCChanPetState): number {
  const animation = useMemo(() => getPetAnimation(pet, state), [pet, state]);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const frameCount = Math.max(1, animation.frames);
    setFrame(0);
    // 单帧精灵没有可推进的帧，不必起定时器。
    if (frameCount === 1) return;
    // 按精灵自身帧率（通常个位数 fps）跑定时器，而不是每帧 rAF：常驻 rAF 会让主线程
    // 每帧都去推进全页动画样式，精灵 1 fps 也要付 60 Hz 的代价。隐藏时停。
    return startVisibleInterval(
      () => setFrame((current) => (current + 1) % frameCount),
      1000 / Math.max(1, animation.fps),
    );
  }, [animation.frames, animation.fps, pet.id, state]);

  return frame;
}
