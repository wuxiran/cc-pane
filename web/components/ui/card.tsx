import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 软卡片原语（docs/46 §6）：设置块统一 8px 圆角软卡片带。
 * 底色/边框定死 --app-panel-bg / --app-border，禁止卡片嵌套。
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-start gap-2.5 px-4 pt-4", className)}
      {...props}
    />
  );
}

/** 卡头左侧 8px 圆角图标底（lucide size-4） */
function CardIcon({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-icon"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-hover)] text-[var(--app-text-secondary)]",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      className={cn("text-sm font-semibold leading-tight text-[var(--app-text-primary)]", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("mt-0.5 text-xs text-[var(--app-text-tertiary)]", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("px-4 pb-4 pt-3", className)} {...props} />
  );
}

export { Card, CardHeader, CardIcon, CardTitle, CardDescription, CardContent };
