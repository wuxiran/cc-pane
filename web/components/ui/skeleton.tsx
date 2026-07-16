import { cn } from "@/lib/utils";

/** 骨架屏占位块：加载态用，配合布局占位组合出列表/卡片骨架 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-[color-mix(in_srgb,var(--app-text-primary)_7%,transparent)]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
