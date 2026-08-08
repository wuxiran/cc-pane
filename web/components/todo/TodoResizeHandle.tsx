import { useEffect, useRef } from "react";

interface TodoResizeHandleProps {
  label: string;
  onResize: (deltaX: number) => void;
}

export default function TodoResizeHandle({ label, onResize }: TodoResizeHandleProps) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let previousX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const stopResize = () => {
      window.removeEventListener("pointermove", moveResize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupRef.current = null;
    };
    const moveResize = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - previousX;
      previousX = moveEvent.clientX;
      if (deltaX) onResize(deltaX);
    };

    cleanupRef.current?.();
    cleanupRef.current = stopResize;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", moveResize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onResize(-12);
        if (event.key === "ArrowRight") onResize(12);
      }}
      className="splitview-sash vertical z-20 outline-none focus-visible:bg-primary/20"
    >
    </div>
  );
}
