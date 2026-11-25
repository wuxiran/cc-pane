// 语音设置的版式：分组卡片 + 行（左标题说明、右控件、下方可挂内容），参照 t3code。
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SearchableSetting } from "../SettingsSearchContext";

export function VoiceGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <SearchableSetting sectionId={id}>
      <section className="flex flex-col gap-1.5" aria-label={title}>
        <h4
          className="px-1 text-[length:var(--text-caption)] font-semibold"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {title}
        </h4>
        <div
          className="flex flex-col divide-y divide-[var(--app-border)] rounded-lg border"
          style={{ borderColor: "var(--app-border)", background: "var(--app-content)" }}
        >
          {children}
        </div>
      </section>
    </SearchableSetting>
  );
}

export function VoiceRow({
  title,
  description,
  control,
  children,
  htmlFor,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  /** 控件是单个表单元素时，标题做成它的 label。 */
  htmlFor?: string;
}) {
  const Title = htmlFor ? "label" : "div";
  return (
    <div className="px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <Title
            {...(htmlFor ? { htmlFor } : {})}
            className="block text-[length:var(--text-row)] font-medium"
            style={{ color: "var(--app-text-primary)" }}
          >
            {title}
          </Title>
          {description ? (
            <p className="m-0 mt-0.5 text-[length:var(--text-small)] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
              {description}
            </p>
          ) : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-1.5">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** 行内的浅底面板（录音中、回放、试转写结果），右侧带关闭按钮。 */
export function VoiceInlinePanel({
  children,
  onClose,
  closeLabel,
  className,
}: {
  children: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("mt-3 flex min-h-10 items-center gap-3 rounded-lg border py-1 pe-1 ps-3", className)}
      style={{ borderColor: "var(--app-border)", background: "var(--app-hover)" }}
    >
      {children}
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="ms-auto flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-active-bg)]"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

const BAR_WEIGHTS = [0.35, 0.6, 0.85, 1, 0.75, 0.5, 0.9, 0.65, 0.4, 0.7, 0.95, 0.55];

/** 电平条：随输入音量起伏，静音时贴底。 */
export function VoiceLevelBars({ level }: { level: number }) {
  const { t } = useTranslation("settings");
  return (
    <span className="flex h-5 items-center gap-[3px]" role="meter" aria-label={t("voiceInputLevel")} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(2))}>
      {BAR_WEIGHTS.map((weight, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="w-[3px] rounded-full transition-[height] duration-75"
          style={{
            height: `${Math.max(3, Math.round(20 * Math.min(1, level * weight * 1.4)))}px`,
            background: "var(--app-accent)",
          }}
        />
      ))}
    </span>
  );
}

export function RecordingDot() {
  return <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full" style={{ background: "var(--app-status-danger)" }} />;
}

export const VOICE_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[length:var(--text-row)] font-medium transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50 [&_svg]:size-3.5";

export const VOICE_BUTTON_STYLE = {
  borderColor: "var(--app-border)",
  background: "var(--app-content)",
  color: "var(--app-text-primary)",
} as const;

export const VOICE_ICON_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)] disabled:opacity-40 [&_svg]:size-3.5";
