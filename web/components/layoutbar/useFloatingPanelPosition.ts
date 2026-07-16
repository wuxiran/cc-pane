import { useRef, useState } from "react";

export interface FloatingPosition {
  left: number;
  top: number;
}

const FLOATING_PANEL_WIDTH = 256;
const FLOATING_PANEL_MARGIN = 8;
const FLOATING_PANEL_GAP = 10;
const FLOATING_PANEL_DEFAULT_HEIGHT = 360;

export function useFloatingPanelPosition() {
  const rootRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);

  function clampFloatingPosition(position: FloatingPosition): FloatingPosition {
    const panelHeight = floatingRef.current?.offsetHeight ?? FLOATING_PANEL_DEFAULT_HEIGHT;
    const maxLeft = Math.max(
      FLOATING_PANEL_MARGIN,
      window.innerWidth - FLOATING_PANEL_WIDTH - FLOATING_PANEL_MARGIN,
    );
    const maxTop = Math.max(
      FLOATING_PANEL_MARGIN,
      window.innerHeight - panelHeight - FLOATING_PANEL_MARGIN,
    );
    return {
      left: Math.min(Math.max(position.left, FLOATING_PANEL_MARGIN), maxLeft),
      top: Math.min(Math.max(position.top, FLOATING_PANEL_MARGIN), maxTop),
    };
  }

  function defaultFloatingPosition() {
    const root = rootRef.current;
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    return clampFloatingPosition({
      left: rect.right + FLOATING_PANEL_GAP,
      top: rect.top,
    });
  }

  function updateFloatingPosition(options: { preserve?: boolean } = {}) {
    if (options.preserve) {
      setFloatingPosition((current) => current ? clampFloatingPosition(current) : defaultFloatingPosition());
      return;
    }
    const nextPosition = defaultFloatingPosition();
    if (nextPosition) {
      setFloatingPosition(nextPosition);
    }
  }

  return {
    rootRef,
    floatingRef,
    floatingPosition,
    setFloatingPosition,
    clampFloatingPosition,
    defaultFloatingPosition,
    updateFloatingPosition,
  };
}
