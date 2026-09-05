import * as React from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleCheckGroupProps {
  /** 组标题 */
  title: React.ReactNode;
  /** 总项数 */
  total: number;
  /** 已启用项数 */
  enabledCount: number;
  /** 折叠态展示的已启用项名称（chips 摘要，内部截取前 maxChips 个） */
  enabledNames?: string[];
  /** 组头右侧动作（全选/清空等） */
  actions?: React.ReactNode;
  /** 计数文案格式化（i18n 由调用方注入，如 (t,e)=>`${t} 项 · 启用 ${e}`） */
  formatCount: (total: number, enabled: number) => string;
  /** chips 摘要溢出文案（如 (n)=>`+${n}`） */
  formatMore?: (hidden: number) => string;
  /** 短分组阈值：total ≤ collapseThreshold 时恒展开且不显示折叠交互 */
  collapseThreshold?: number;
  defaultOpen?: boolean;
  /**
   * 强制展开（搜索命中时用）。`defaultOpen` 只在 mount 取一次值，
   * 查询词变化时展不开，所以需要这个每次渲染都生效的开关。
   */
  forceOpen?: boolean;
  maxChips?: number;
  children: React.ReactNode;
  className?: string;
}

/**
 * 长列表分组（Skill / MCP / 共享 MCP 三处共用）：
 * - 短分组（≤阈值）平铺，无折叠交互；
 * - 长分组默认折叠：组头 `n 项 · 启用 m` + 已启用 chips 摘要；
 * - 展开后列表进 max-h 内滚动区，卡片不被撑长。
 */
export function CollapsibleCheckGroup({
  title,
  total,
  enabledCount,
  enabledNames = [],
  actions,
  formatCount,
  formatMore,
  collapseThreshold = 8,
  defaultOpen,
  forceOpen = false,
  maxChips = 6,
  children,
  className,
}: CollapsibleCheckGroupProps) {
  const collapsible = total > collapseThreshold;
  const [open, setOpen] = useState(defaultOpen ?? !collapsible);
  const expanded = !collapsible || open || forceOpen;
  const shownChips = enabledNames.slice(0, maxChips);
  const hiddenCount = Math.max(0, enabledNames.length - shownChips.length);

  return (
    <div className={cn("border-t border-[var(--app-border)]/60 pt-1", className)}>
      <div
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
        className={cn(
          "flex items-center gap-1.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-primary)]",
          collapsible && "cursor-pointer select-none",
        )}
      >
        {collapsible &&
          (expanded ? (
            <ChevronDown className="size-3 text-[var(--app-text-tertiary)]" />
          ) : (
            <ChevronRight className="size-3 text-[var(--app-text-tertiary)]" />
          ))}
        <span>{title}</span>
        <span className="text-[11px] font-normal text-[var(--app-text-tertiary)]">
          {formatCount(total, enabledCount)}
        </span>
        {actions && (
          <span className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>

      {!expanded && shownChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-2 pl-[18px]">
          {shownChips.map((name) => (
            <span
              key={name}
              className="rounded-full border border-[var(--app-border)] bg-[var(--app-hover)] px-2 py-0.5 text-[11px] text-[var(--app-text-secondary)]"
            >
              {name}
            </span>
          ))}
          {hiddenCount > 0 && formatMore && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-full border border-dashed border-[var(--app-border)] px-2 py-0.5 text-[11px] text-[var(--app-accent)] transition-[color,background-color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--app-hover)] active:scale-[0.97] motion-reduce:active:scale-100"
            >
              {formatMore(hiddenCount)}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div
          className={cn(
            "space-y-1.5 pb-2",
            collapsible && "max-h-[260px] overflow-y-auto pr-1",
          )}
        >
          {children}
        </div>
      )}

      {/* 长分组展开后滚动区会截断视野，底部复述一遍计数，避免「看到的就是全部」的错觉 */}
      {expanded && collapsible && (
        <div className="pb-2 pl-[18px] text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {formatCount(total, enabledCount)}
        </div>
      )}
    </div>
  );
}
