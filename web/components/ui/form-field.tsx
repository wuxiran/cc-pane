// 表单字段封装：自动 useId 生成 id，给 Label htmlFor、给控件 id，
// 消灭「视觉 Label 无编程关联」的 a11y 缺口。render-prop 形态——
// cloneElement 对 Radix SelectTrigger 这类复合控件不可控，显式传 id 最稳。
// 只做关联，不改任何样式：wrapper/label/hint 的 className 全由调用方按原样传入。
import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/label";

export interface FormFieldIds {
  /** 控件 id：Label 的 htmlFor 指向它，把控件本身设成这个 id 即完成关联 */
  id: string;
  /** Label 自身的 id：控件无法消费 id/htmlFor 时（如按钮组）用它做 aria-labelledby */
  labelId: string;
  /** hint 渲染时的描述文字 id；控件需要 aria-describedby 关联时挂它 */
  hintId?: string;
}

interface FormFieldProps {
  /** 标签文案（通常 t("xxx")） */
  label: ReactNode;
  /** 可选描述文字；渲染为控件下方的说明，并通过 hintId 供 aria-describedby 关联 */
  hint?: ReactNode;
  /** wrapper div 的 className——按被替换的原 wrapper 原样传入，保证视觉零变化 */
  className?: string;
  /** Label 的 className——按原 Label 的 className 原样传入 */
  labelClassName?: string;
  /** hint 的 className——按原说明文字的 className 原样传入 */
  hintClassName?: string;
  children: (ids: FormFieldIds) => ReactNode;
}

/**
 * ```tsx
 * <FormField label={t("host")} className="flex flex-col gap-1" labelClassName="text-xs">
 *   {({ id }) => <Input id={id} value={host} onChange={...} />}
 * </FormField>
 * ```
 */
function FormField({
  label,
  hint,
  className,
  labelClassName,
  hintClassName,
  children,
}: FormFieldProps) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const hintId = hint !== undefined && hint !== null ? `${baseId}-hint` : undefined;

  return (
    <div className={className}>
      <Label id={labelId} htmlFor={baseId} className={labelClassName}>
        {label}
      </Label>
      {children({ id: baseId, labelId, hintId })}
      {hintId ? (
        <p id={hintId} className={hintClassName}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export { FormField };
