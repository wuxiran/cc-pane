/**
 * "性能" 设置面板的基础控件（docs/107 W1）。
 *
 * 从 `PerformanceSection.tsx` 拆出以守住 ≤300 行：分组标题、开关行、
 * 带钳位的数字输入（支持 `null` = 自动）。所有文案都走 `settings` 命名空间。
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export interface NumberLimits {
  readonly min: number;
  readonly max: number;
}

/** 钳位到 [min, max] 并取整；非数字返回 fallback。 */
export function clampNumber(raw: unknown, limits: NumberLimits, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(n)));
}

export function GroupTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 mt-2">
      <h4 className="text-[13px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
        {children}
      </h4>
      {hint ? (
        <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
      {children}
    </p>
  );
}

interface ToggleRowProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow({ id, label, hint, checked, onCheckedChange, disabled }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <Hint>{hint}</Hint> : null}
      </div>
      <Switch
        id={id}
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}

interface NumberRowProps {
  id: string;
  label: string;
  hint?: string;
  value: number;
  limits: NumberLimits;
  fallback: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  suffix?: string;
}

/** 必填数字：输入时原样透传，失焦时钳到区间内（空值回落到 fallback）。 */
export function NumberRow({ id, label, hint, value, limits, fallback, onChange, disabled, suffix }: NumberRowProps) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <Hint>{hint}</Hint> : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Input
          id={id}
          type="number"
          className="w-28"
          min={limits.min}
          max={limits.max}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={(e) => {
            const next = clampNumber(e.target.value === "" ? NaN : e.target.value, limits, fallback);
            if (next !== value) onChange(next);
          }}
        />
        {suffix ? (
          <span className="text-[12px]" style={{ color: "var(--app-text-secondary)" }}>{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}

interface NullableNumberRowProps {
  id: string;
  label: string;
  hint?: string;
  value: number | null;
  limits: NumberLimits;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

/** 可空数字：留空 = 自动（由后端按核数折算）；失焦时非空值钳到区间内。 */
export function NullableNumberRow({ id, label, hint, value, limits, onChange, disabled }: NullableNumberRowProps) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <Hint>{hint}</Hint> : null}
      </div>
      <Input
        id={id}
        type="number"
        className="w-28 shrink-0"
        min={limits.min}
        max={limits.max}
        step={1}
        placeholder={t("performance.auto")}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        onBlur={(e) => {
          if (e.target.value === "") {
            if (value !== null) onChange(null);
            return;
          }
          const next = clampNumber(e.target.value, limits, limits.min);
          if (next !== value) onChange(next);
        }}
      />
    </div>
  );
}
