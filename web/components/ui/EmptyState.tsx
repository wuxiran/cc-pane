import { LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** 主操作（可选）：如"新建工作空间" */
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

interface LoadingStateProps {
  message: string;
  className?: string;
}

/** 统一空状态：细描边图标 + 标题 + 说明 + 可选 CTA（对齐 demo 的留白与弱化风格） */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center select-none",
        className,
      )}
    >
      <div
        className="flex h-11 w-11 items-center justify-center rounded-xl mb-1"
        style={{
          background: "color-mix(in srgb, var(--app-text-primary) 5%, transparent)",
          boxShadow: "var(--hi, none)",
        }}
      >
        <Icon className="h-5 w-5 text-[var(--app-text-tertiary)]" strokeWidth={1.5} />
      </div>
      <div className="text-[13px] font-medium text-[var(--app-text-secondary)]">{title}</div>
      {description && (
        <p className="max-w-[260px] text-xs leading-relaxed text-[var(--app-text-tertiary)]">
          {description}
        </p>
      )}
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** 统一加载状态：保留简洁文案，同时向辅助技术声明异步更新。 */
export function LoadingState({ message, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex items-center justify-center gap-2 text-[13px] text-[var(--app-text-tertiary)]",
        className,
      )}
    >
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      <span>{message}</span>
    </div>
  );
}
