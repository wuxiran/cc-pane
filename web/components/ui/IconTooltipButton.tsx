import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface IconTooltipButtonProps extends React.ComponentProps<"button"> {
  /** tooltip 文案（同时作为 aria-label） */
  label: string;
  /** 可选快捷键徽标，如 "Ctrl+K" */
  kbd?: string;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * 图标按钮 + 统一 shadcn Tooltip（替代散落的原生 title=）。
 * 默认提供 hover 背景与过渡；外部样式经 className 叠加。
 */
export function IconTooltipButton({
  label,
  kbd,
  side = "top",
  className,
  children,
  ...props
}: IconTooltipButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex items-center justify-center rounded-md p-1 text-[var(--app-text-secondary)]",
            "transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]",
            "disabled:pointer-events-none disabled:opacity-50",
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={6}>
        <span className="flex items-center gap-1.5">
          {label}
          {kbd && (
            <kbd className="rounded border border-[var(--app-border)] bg-[var(--app-hover)] px-1 py-px font-mono text-[10px] leading-none text-[var(--app-text-tertiary)]">
              {kbd}
            </kbd>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
