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
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const count = Math.max(1, animation.frames);
    const interval = 1000 / Math.max(1, animation.fps);
    let rafId = 0;
    let lastFrameAt = 0;
    let current = 0;
    function tick(now: number) {
      const elapsed = Math.floor((now - lastFrameAt) / interval);
      if (elapsed > 0) {
        lastFrameAt += elapsed * interval;
        current = (current + elapsed) % count;
        setFrame(current);
      }
      rafId = requestAnimationFrame(tick);
    }
    function restart() {
      cancelAnimationFrame(rafId);
      current = 0;
      setFrame(0);
      if (count <= 1 || document.hidden || motion?.matches) return;
      lastFrameAt = performance.now();
      rafId = requestAnimationFrame(tick);
    }
    restart();
    document.addEventListener("visibilitychange", restart);
    motion?.addEventListener("change", restart);
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("visibilitychange", restart);
      motion?.removeEventListener("change", restart);
    };
  }, [animation.frames, animation.fps, animation.row, animation.colOffset, pet.id, state]);
  return frame;
}
