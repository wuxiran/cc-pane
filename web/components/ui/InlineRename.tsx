import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface InlineRenameProps {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
  focusDelayMs?: number;
  confirmOnBlur?: boolean;
  confirmOnOutsidePointerDown?: boolean;
}

export default function InlineRename({
  value,
  onChange,
  onConfirm,
  onCancel,
  className,
  style,
  focusDelayMs = 50,
  confirmOnBlur = true,
  confirmOnOutsidePointerDown = false,
}: InlineRenameProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onConfirmRef = useRef(onConfirm);
  const initialValueRef = useRef(value);
  const focusDelayRef = useRef(focusDelayMs);

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (input.value === initialValueRef.current) {
        input.select();
      }
    }, focusDelayRef.current);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!confirmOnOutsidePointerDown) return;

    function handlePointerDown(event: PointerEvent) {
      const input = inputRef.current;
      const target = event.target;
      if (!input || !(target instanceof Node) || input.contains(target)) return;
      onConfirmRef.current();
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [confirmOnOutsidePointerDown]);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      // 默认 120ms 颜色/边框/阴影过渡：调用方给的 focus 边框与底色不再瞬时闪现；
      // 调用方 className 仍可经 twMerge 覆盖。
      className={cn(
        "transition-[color,background-color,border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        className,
      )}
      style={style}
      onBlur={confirmOnBlur ? onConfirm : undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter") onConfirm();
        if (event.key === "Escape") onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}
