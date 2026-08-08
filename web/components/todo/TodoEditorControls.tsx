import type { ReactNode } from "react";

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  colorMap,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  colorMap?: Record<string, string>;
}) {
  return (
    <div className="flex rounded-md border border-border/40 bg-muted/30 p-0.5">
      {options.map((option) => {
        const isActive = option.value === value;
        const activeColor = colorMap?.[option.value];
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded-sm px-2 py-1.5 text-xs font-medium transition-all duration-[var(--dur-fast)]
              ${
                isActive
                  ? activeColor ?? "bg-primary/15 text-primary shadow-sm border border-primary/25"
                  : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function PropertyRow({
  icon,
  label,
  className = "",
  children,
}: {
  icon: ReactNode;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`grid min-w-0 grid-cols-[96px_minmax(0,1fr)] items-center gap-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">{icon}</span>
        <span className="truncate text-xs font-medium">{label}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
