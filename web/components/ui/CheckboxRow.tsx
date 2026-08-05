import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface CheckboxRowProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** 行尾元数据（Badge、状态文本等） */
  trailing?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * 规范勾选行（docs/46 §3/§4）：行底色与边框保持中性，
 * 选中态只有 checkbox 打勾 + 左侧 2px accent inset 边条——
 * accent 从「满屏面」退为「细线索」，汇总信息交给区头计数。
 */
export function CheckboxRow({
  checked,
  onCheckedChange,
  label,
  description,
  trailing,
  disabled,
  className,
}: CheckboxRowProps) {
  return (
    <label
      data-checked={checked ? "true" : undefined}
      className={cn(
        "relative flex cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--app-border)] px-3 py-2 transition-colors",
        "hover:bg-[var(--app-hover)]",
        checked &&
          "before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-[var(--app-accent)] before:content-['']",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <Checkbox checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-[var(--app-text-primary)]">{label}</span>
        {description && (
          <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--app-text-tertiary)]">
            {description}
          </span>
        )}
      </span>
      {trailing && <span className="ml-auto shrink-0 text-[11px] text-[var(--app-text-tertiary)]">{trailing}</span>}
    </label>
  );
}
