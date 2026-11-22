import type { CSSProperties } from "react";
import { accountColorVar } from "@/utils/providerAccounts";

interface AccountColorDotProps {
  color?: string | null;
  /** 悬浮提示（账号名）。不给就当装饰，读屏跳过。 */
  title?: string;
  size?: "xs" | "sm" | "md";
  className?: string;
}

const SIZE_CLASS = { xs: "size-1.5", sm: "size-2", md: "size-3" } as const;

/** 账号颜色小圆点。颜色不认识（外部导入的任意值）时画成次要文字色，不写裸颜色。 */
export default function AccountColorDot({ color, title, size = "sm", className = "" }: AccountColorDotProps) {
  const colorValue = accountColorVar(color) ?? "var(--app-text-tertiary)";
  const style = { backgroundColor: colorValue } satisfies CSSProperties;
  return (
    <span
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      data-testid="account-color-dot"
      data-color={color ?? undefined}
      className={`${SIZE_CLASS[size]} inline-block shrink-0 rounded-full ${className}`}
      style={style}
    />
  );
}
