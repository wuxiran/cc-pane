import { useEffect, useMemo, useState } from "react";
import type { PetMeta } from "./types";
import { resolvePetAnimation, type PetStatus } from "./petStatus";
import { startVisibleInterval } from "@/utils/visibleInterval";

export function getPetAnimation(pet: PetMeta, status: PetStatus) {
  return resolvePetAnimation(pet, status);
}

export function usePetAnimationFrame(pet: PetMeta, status: PetStatus): number {
  const animation = useMemo(() => getPetAnimation(pet, status), [pet, status]);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const frameCount = Math.max(1, animation.frames);
    let stopTimer: (() => void) | undefined;
    // 按精灵自身帧率（通常个位数 fps）跑定时器，而不是每帧 rAF：常驻 rAF 会让主线程
    // 每帧都去推进全页动画样式，精灵 1 fps 也要付 60 Hz 的代价。隐藏时由
    // startVisibleInterval 停表；用户开启“减少动态效果”时停在首帧。
    function restart() {
      stopTimer?.();
      stopTimer = undefined;
      setFrame(0);
      if (frameCount === 1 || motion?.matches) return;
      stopTimer = startVisibleInterval(
        () => setFrame((current) => (current + 1) % frameCount),
        1000 / Math.max(1, animation.fps),
      );
    }
    restart();
    motion?.addEventListener?.("change", restart);
    return () => {
      stopTimer?.();
      motion?.removeEventListener?.("change", restart);
    };
  }, [animation.frames, animation.fps, animation.row, animation.colOffset, pet.id, status]);
  return frame;
}
