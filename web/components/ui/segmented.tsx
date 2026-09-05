import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedItem<V extends string = string> {
  value: V;
  label: React.ReactNode;
  disabled?: boolean;
}

interface SegmentedTabsProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  items: ReadonlyArray<SegmentedItem<V>>;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

/**
 * 单选分段控件（docs/46 §1 已知列表单选）：
 * 容器 hover 底 + 激活项 panel 底浮起，替代散落的 default/outline Button 对。
 */
export function SegmentedTabs<V extends string = string>({
  value,
  onValueChange,
  items,
  size = "md",
  className,
  ...rest
}: SegmentedTabsProps<V>) {
  return (
    <div
      role="tablist"
      aria-label={rest["aria-label"]}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-[var(--app-hover)] p-0.5",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            data-state={active ? "active" : "inactive"}
            className={cn(
              "ui-hoverable rounded-[7px] font-medium",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-[13px]",
              active
                ? // 选中签名统一为 ui-selected 左侧 2px primary 条（box-shadow 不可叠加，
                  // 与原 shadow-sm 二选一）；panel 底浮起 + 指示条已足够区分激活项。
                  "ui-selected bg-[var(--app-panel-bg)] text-[var(--app-text-primary)]"
                : "text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]",
              "disabled:pointer-events-none disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
            )}
            onClick={() => onValueChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
