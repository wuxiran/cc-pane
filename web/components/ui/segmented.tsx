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
 * 凹槽容器（深底 + 细边）+ 激活项浮起的实心胶囊，替代散落的 default/outline Button 对。
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
        "inline-flex items-center gap-0.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-deep)] p-[3px]",
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
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-[length:var(--text-row)]",
              active
                ? // 胶囊控件不用 ui-selected 左侧竖条（那是列表项的选中签名，落在胶囊上
                  // 只剩一道歪在边上的线）。激活项 = 浮起的实心底 + 细边 + 轻阴影，靠形体区分。
                  "bg-[var(--app-panel-bg)] text-[var(--app-text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.18),0_0_0_1px_var(--app-border)]"
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
