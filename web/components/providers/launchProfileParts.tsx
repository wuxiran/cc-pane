import type { ReactNode } from "react";
import { Info, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 卡头跨分组搜索框（Skill / MCP 卡共用）。
 * external/market skill 与共享 MCP 可能几十上百项，折叠分组只解决「卡片被撑长」，
 * 「我那条在哪个组」还得靠这个——查询词只做本地过滤，不进 draft。
 */
export function GroupSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-44">
      <Search
        size={13}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        style={{ color: "var(--app-text-tertiary)" }}
      />
      <input
        type="search"
        className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-xs"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5 text-xs">
      <span className="flex items-center gap-1 font-medium" style={{ color: "var(--app-text-secondary)" }}>
        {label}
        {hint ? <HintIcon text={hint} /> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * 表单分段（扁平化后）：不再各自一张卡，由面板统一包进一张卡、分隔线隔开。
 * 标题行：图标 + 标题 + ⓘ（长说明）左侧，主控件与次要动作靠右；正文只放真正要操作的东西。
 */
export function Section({
  id,
  title,
  hint,
  icon,
  headerControl,
  headerActions,
  children,
}: {
  id?: string;
  title: string;
  hint?: string;
  icon?: ReactNode;
  headerControl?: ReactNode;
  headerActions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-14 px-4 py-3">
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1.5">
        {icon ? <span className="shrink-0 text-[var(--app-text-tertiary)]">{icon}</span> : null}
        <h3 className="text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{title}</h3>
        {hint ? <HintIcon text={hint} /> : null}
        <div className="ml-auto flex items-center gap-1.5">
          {headerControl}
          {headerActions}
        </div>
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </section>
  );
}

/** 无边框的行内勾选：多个开关横排在一行，替代一项一张的 CheckboxRow 卡片 */
export function InlineCheck({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex cursor-default items-center gap-1.5 text-xs" style={{ color: "var(--app-text-primary)" }}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <span>{label}</span>
      {hint ? <HintIcon text={hint} /> : null}
    </label>
  );
}

/** 长说明收进 ⓘ 悬停，不占版面 */
export function HintIcon({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span 而非 button：Field 是 <label>，里面放 button 会抢走 label 的激活目标 */}
        <span
          role="img"
          tabIndex={0}
          aria-label={text}
          className="inline-flex shrink-0 cursor-help items-center text-[var(--app-text-tertiary)] hover:text-[var(--app-text-secondary)]"
        >
          <Info size={13} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal leading-5">{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 「默认组合」到底注入了什么：取后端启动预览（与真实启动同一解析），逐个列出名字。
 * 预览按已保存的配置算；草稿有改动时标一句「保存后刷新」，不假装是改动后的结果。
 */
export function EffectiveList({
  items,
  stale,
  testId,
}: {
  items?: readonly { id: string; name: string }[] | null;
  stale?: boolean;
  testId: string;
}) {
  const { t } = useTranslation("providers");
  if (!items) return null;
  return (
    <div data-testid={testId} className="mt-2 flex flex-wrap items-center gap-1 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
      <span className="mr-0.5">{t("effectiveInjected")}</span>
      {items.length === 0 ? (
        <span>{t("effectiveNone")}</span>
      ) : items.map((item) => (
        <span
          key={item.id}
          className="rounded border border-[var(--app-border)] px-1.5 leading-5"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {item.name}
        </span>
      ))}
      {stale ? <span className="ml-1 italic">· {t("effectiveStale")}</span> : null}
    </div>
  );
}
