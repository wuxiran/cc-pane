// lucideSolidShim 的工厂：把 Phosphor 图标包成 lucide 组件的形状（同样的 props、class、尺寸默认值）。
import { createElement, forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react/dist/esm/lucide-react.js";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

function hasA11yProp(props: Record<string, unknown>) {
  return Object.keys(props).some((key) => key.startsWith("aria-") || key === "role" || key === "title");
}

const FILL_CLASS = /(^|\s)fill-(?!none\b)[\w[\]()-]+/;

/**
 * 调用方原本用 fill 表达的意图要保留，否则会丢状态（收藏/未收藏）或丢颜色（状态点）：
 * - fill="none" 明确要空心 → regular 线框款（「关」的那一态）
 * - fill 给了颜色 → 实心，并用该颜色着色
 * - className 里有 fill-current 之类 → 实心
 * 其余走该图标的默认粗细。
 */
export function resolveSolidWeight(
  defaultWeight: SolidWeight,
  fill: unknown,
  className: string | undefined,
): { weight: SolidWeight | "regular"; fillColor?: string } {
  if (fill === "none" || fill === "transparent") return { weight: "regular" };
  if (typeof fill === "string" && fill !== "") {
    return { weight: "fill", fillColor: fill === "currentColor" ? undefined : fill };
  }
  if (className && FILL_CLASS.test(className)) return { weight: "fill" };
  return { weight: defaultWeight };
}

export type SolidWeight = "fill" | "bold";

export function solid(Ph: PhosphorIcon, defaultWeight: SolidWeight, lucideClass: string, name: string): LucideIcon {
  const Component = forwardRef<SVGSVGElement, LucideProps>(function SolidIcon(
    {
      size = 24,
      color,
      className,
      // 线框专属参数对实心款没有意义；stroke 若透传会给实心块描上一圈
      strokeWidth: _strokeWidth,
      absoluteStrokeWidth: _absoluteStrokeWidth,
      fill,
      stroke: _stroke,
      ...rest
    },
    ref,
  ) {
    const { weight, fillColor } = resolveSolidWeight(defaultWeight, fill, className);
    const dataAttrs: Record<`data-${string}`, string> = { "data-icon-weight": weight };
    return createElement(Ph, {
      ref,
      size,
      color: color ?? fillColor ?? "currentColor",
      weight,
      className: ["lucide", lucideClass, className].filter(Boolean).join(" "),
      // 实际用了哪档粗细：排查与测试用（fill/stroke 属性已被 Phosphor 统一成 color，看不出差别）
      ...dataAttrs,
      ...(hasA11yProp(rest) ? {} : { "aria-hidden": true }),
      ...rest,
    });
  });
  Component.displayName = name;
  return Component as unknown as LucideIcon;
}
