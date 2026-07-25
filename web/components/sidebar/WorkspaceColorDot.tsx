import type { CSSProperties } from "react";
import type { WorkspaceColor } from "@/types";

const COLOR_VARIABLES: Record<WorkspaceColor, string> = {
  red: "var(--app-tag-red)",
  amber: "var(--app-tag-amber)",
  green: "var(--app-tag-green)",
  blue: "var(--app-tag-blue)",
  purple: "var(--app-tag-purple)",
  pink: "var(--app-tag-pink)",
  cyan: "var(--app-tag-cyan)",
  gray: "var(--app-tag-gray)",
};

interface WorkspaceColorDotProps {
  color: WorkspaceColor;
  size?: "sm" | "md";
  className?: string;
}

export default function WorkspaceColorDot({
  color,
  size = "sm",
  className = "",
}: WorkspaceColorDotProps) {
  const colorValue = COLOR_VARIABLES[color];
  const style = {
    backgroundColor: colorValue,
    boxShadow: `0 0 0 2px color-mix(in srgb, ${colorValue} 18%, transparent)`,
  } satisfies CSSProperties;

  return (
    <span
      aria-hidden="true"
      data-color={color}
      data-testid="workspace-color-dot"
      className={`${size === "md" ? "size-3" : "size-2"} shrink-0 rounded-full ${className}`}
      style={style}
    />
  );
}
