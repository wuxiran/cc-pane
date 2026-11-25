/**
 * 设置页版式原语（T3 风格）。所有设置页只用这四层，**永不嵌套**：
 *
 *   SettingsPage（页标题 + 居中定宽列）
 *     └─ SettingsSection（可选小标题 + 一张扁平卡片，卡内行与行之间是发丝线）
 *          └─ SettingsRow（一行一个设置：左侧标题/说明，右侧控件）
 *             SettingsBlock（无法拆成「标题 + 控件」的整块内容：预览、卡片网格、列表）
 *             SettingsNavRow（点开子页面/弹窗的行，右侧是箭头）
 *
 * 规则：
 * - 卡片里不放卡片；Section 不折叠、标题不带图标砖；需要分组就并列多个 Section。
 * - 布尔值用 Switch，不用 Checkbox；Row 传 `htmlFor` 让标题成为控件的 label。
 * - 当前值/路径/提示这类元数据放进 Row 的 children（标题下方），不挤在标题旁。
 * - 搜索锚点：Section 传 `sectionId`（只锚定 + 高亮）；需要「搜索时隐藏未命中段」的
 *   用 `<SearchableSetting sectionId>` 包住 Section，它会把锚点属性透传进来。
 */
import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useSettingsSectionHighlighted } from "../SettingsSearchContext";

const HIGHLIGHT_CLASS =
  "ring-2 ring-[var(--app-accent)] ring-offset-2 ring-offset-[var(--app-content)]";

interface SettingsPageProps {
  title: ReactNode;
  description?: ReactNode;
  /** 页尾的安静动作（如「恢复本页默认」）与说明文字。 */
  footer?: ReactNode;
  /** 宽内容（列表 + 编辑器双栏、图表）放宽到约 1080px，默认约 760px。 */
  wide?: boolean;
  children: ReactNode;
}

export function SettingsPage({ title, description, footer, wide = false, children }: SettingsPageProps) {
  return (
    <div
      data-testid="settings-page"
      className={cn("mx-auto w-full pb-10 pt-6", wide ? "max-w-[1080px]" : "max-w-[760px]")}
    >
      <h1 className="text-[20px] font-semibold leading-7 text-[var(--app-text-primary)]">{title}</h1>
      {description ? (
        <p className="mt-1 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{description}</p>
      ) : null}
      <div className="mt-6 flex flex-col gap-7">{children}</div>
      {footer ? (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

interface SettingsSectionProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  /** 标题行右侧的小动作（如「恢复默认形态」），保持 ghost/outline 级别。 */
  actions?: ReactNode;
  /** 搜索/跳转锚点（data-settings-section），命中时整段高亮。 */
  sectionId?: string;
  /** 卡片本体额外样式；整段需要固定高度时用。 */
  cardClassName?: string;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  actions,
  sectionId,
  cardClassName,
  className,
  children,
  ...rest
}: SettingsSectionProps) {
  const headingId = useId();
  const highlighted = useSettingsSectionHighlighted(sectionId);
  const anchorProps = sectionId ? { "data-settings-section": sectionId } : {};
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      {...anchorProps}
      {...rest}
      className={cn("flex scroll-m-8 flex-col gap-2", className)}
    >
      {title || actions ? (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            {title ? (
              <h2
                id={headingId}
                className="text-[length:var(--text-caption)] font-semibold uppercase tracking-[0.04em] text-[var(--app-text-secondary)]"
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
      ) : null}
      <div
        className={cn(
          "shape-panel flex flex-col divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] transition-shadow duration-[var(--dur)]",
          highlighted && HIGHLIGHT_CLASS,
          cardClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

interface SettingsRowProps {
  title: ReactNode;
  description?: ReactNode;
  /** 右侧控件（Switch / Select / Button / Input）。 */
  control?: ReactNode;
  /** 控件是单个表单元素时传它的 id，标题即成为它的 label。 */
  htmlFor?: string;
  /** 可选的细线图标（不加底砖）。 */
  icon?: LucideIcon;
  /** 标题下方的附属内容：当前值、路径、警示、展开后的子字段。 */
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function SettingsRow({
  title,
  description,
  control,
  htmlFor,
  icon: Icon,
  children,
  className,
  "data-testid": testId,
}: SettingsRowProps) {
  const Title = htmlFor ? "label" : "div";
  return (
    <div className={cn("px-4 py-3", className)} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {Icon ? (
          <Icon aria-hidden="true" size={16} strokeWidth={1.6} className="shrink-0 text-[var(--app-text-secondary)]" />
        ) : null}
        <div className="min-w-[12rem] flex-1">
          <Title
            {...(htmlFor ? { htmlFor } : {})}
            className="block text-[length:var(--text-row)] font-medium leading-5 text-[var(--app-text-primary)]"
          >
            {title}
          </Title>
          {description ? (
            <div className="mt-0.5 text-[length:var(--text-small)] leading-5 text-[var(--app-text-tertiary)]">
              {description}
            </div>
          ) : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children ? <div className="mt-2.5 flex flex-col gap-2">{children}</div> : null}
    </div>
  );
}

interface SettingsSwitchRowProps {
  /** 控件 id：标题以它为 label，Switch 的可访问名即标题。 */
  id: string;
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}

/** 布尔设置的标准行：标题 + 说明 + 右侧 Switch。 */
export function SettingsSwitchRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  children,
}: SettingsSwitchRowProps) {
  return (
    <SettingsRow
      title={title}
      description={description}
      htmlFor={id}
      control={<Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />}
    >
      {children}
    </SettingsRow>
  );
}

/** 卡片内的整块内容（预览、卡片网格、列表），与 Row 同样由发丝线分隔。 */
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-4 py-4", className)}>{children}</div>;
}

interface SettingsNavRowProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /** 箭头左侧的当前值摘要。 */
  value?: ReactNode;
  onClick: () => void;
}

/** 打开子页面/弹窗的行：整行可点，右侧箭头。 */
export function SettingsNavRow({ title, description, icon: Icon, value, onClick }: SettingsNavRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-x-4 px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] first:rounded-t-lg last:rounded-b-lg hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
    >
      {Icon ? (
        <Icon aria-hidden="true" size={16} strokeWidth={1.6} className="shrink-0 text-[var(--app-text-secondary)]" />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-row)] font-medium leading-5 text-[var(--app-text-primary)]">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-[length:var(--text-small)] leading-5 text-[var(--app-text-tertiary)]">{description}</span>
        ) : null}
      </span>
      {value ? <span className="shrink-0 text-[length:var(--text-small)] text-[var(--app-text-secondary)]">{value}</span> : null}
      <ChevronRight aria-hidden="true" size={16} strokeWidth={1.6} className="shrink-0 text-[var(--app-text-tertiary)]" />
    </button>
  );
}

interface SettingsRangeControlProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/** Row 右侧的滑杆控件：滑杆 + 等宽数值。配 `<SettingsRow htmlFor={id}>` 使用。 */
export function SettingsRangeControl({ id, value, min, max, step, format, onChange, disabled = false }: SettingsRangeControlProps) {
  return (
    <span className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        className="w-44 cursor-default disabled:cursor-not-allowed disabled:opacity-50"
        style={{ accentColor: "var(--app-accent)" }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-12 text-right font-mono text-[length:var(--text-small)] text-[var(--app-text-secondary)]">
        {format(value)}
      </span>
    </span>
  );
}

/** Row 下方的等宽路径/当前值展示（只读、可选中复制）。 */
export function SettingsValue({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="block select-text overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2.5 py-1.5 font-mono text-[length:var(--text-small)] text-[var(--app-text-secondary)]"
    >
      {children}
    </span>
  );
}

/** Row 下方的次要说明（12px muted）。 */
export function SettingsHint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("m-0 text-[length:var(--text-small)] leading-5 text-[var(--app-text-tertiary)]", className)}>
      {children}
    </p>
  );
}
