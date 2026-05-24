import { useEffect, useMemo, useState } from "react";
import type { CCChanPetState, PetMeta } from "./types";

const FALLBACK_ANIMATION = { row: 0, frames: 1, fps: 1 };

export function getPetAnimation(pet: PetMeta, state: CCChanPetState) {
  return pet.animations[state] ?? pet.animations.idle ?? FALLBACK_ANIMATION;
}

export function usePetAnimationFrame(pet: PetMeta, state: CCChanPetState): number {
  const animation = useMemo(() => getPetAnimation(pet, state), [pet, state]);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let rafId = 0;
    let lastFrameAt = performance.now();
    const frameCount = Math.max(1, animation.frames);
    const interval = 1000 / Math.max(1, animation.fps);

    setFrame(0);

    function tick(now: number) {
      if (now - lastFrameAt >= interval) {
        lastFrameAt = now;
        setFrame((current) => (current + 1) % frameCount);
      }
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [animation.frames, animation.fps, pet.id, state]);

  return frame;
}
