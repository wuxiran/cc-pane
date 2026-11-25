// 侧栏工作空间树里的会话卡（参考 T3 Code 线程卡片）：
//   第一行：项目头像 + 项目名（次要色） …… 状态（形状+颜色+词） · 相对时间
//   第二行：会话标题（主色、单行截断） …… 用过的 CLI/引擎图标（最近的在右）
// 选中态用浮起底色，不用左侧竖条；窄侧栏下各段截断不换行。
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Pin } from "lucide-react";
import CliBrandIcon from "@/components/CliBrandIcon";
import { cliDisplayName } from "@/components/panes/emptyStateShared";
import SessionStatusGlyph, { type StatusGlyphAppearance } from "./SessionStatusGlyph";
import { compactRelativeTime, projectAvatarToken, projectInitials } from "./sessionCardModel";
import type { TerminalStatusType } from "@/types";

export interface SessionCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  title: string;
  projectName: string;
  status: TerminalStatusType | null;
  statusLabel: string;
  /** 用过的 CLI/引擎 id，最近的在后（多引擎并排，最近的在右） */
  engines: readonly string[];
  lastActivityAt: number | null;
  now: number;
  active: boolean;
  pinned?: boolean;
  /** 分屏会话数（>1 时显示 ×N） */
  sessionCount?: number;
  tooltip?: string;
  /** 覆盖状态图标外观（任务视图的「完成 / 等你处理」） */
  statusAppearance?: StatusGlyphAppearance;
}

function ProjectAvatar({ name }: { name: string }) {
  const token = `var(${projectAvatarToken(name)})`;
  return (
    <span
      aria-hidden="true"
      data-project-avatar={projectInitials(name)}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold leading-none tracking-tight"
      style={{
        color: token,
        backgroundColor: `color-mix(in srgb, ${token} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${token} 30%, transparent)`,
      }}
    >
      {projectInitials(name)}
    </span>
  );
}

const SessionCard = forwardRef<HTMLButtonElement, SessionCardProps>(function SessionCard(
  {
    title,
    projectName,
    status,
    statusLabel,
    engines,
    lastActivityAt,
    now,
    active,
    pinned = false,
    sessionCount = 1,
    tooltip,
    statusAppearance,
    className,
    ...buttonProps
  },
  ref,
) {
  const { t } = useTranslation("sidebar");
  const absoluteTime = lastActivityAt ? new Date(lastActivityAt).toLocaleString() : "";
  const engineNames = engines
    .map((engine) => cliDisplayName(engine, t as unknown as (key: string, opts?: Record<string, unknown>) => string))
    .join(" → ");
  return (
    <button
      ref={ref}
      type="button"
      data-session-card=""
      data-active={active || undefined}
      title={tooltip || undefined}
      aria-current={active ? "true" : undefined}
      className={`flex w-full min-w-0 cursor-default flex-col gap-1 rounded-lg px-2 py-1.5 text-left outline-none transition-[background-color,box-shadow] duration-[var(--dur-fast)] focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
        active
          ? "bg-[var(--app-active-bg)] shadow-sm ring-1 ring-inset ring-[var(--app-border)]"
          : "hover:bg-[var(--app-hover)]"
      } ${className ?? ""}`}
      {...buttonProps}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {projectName ? <ProjectAvatar name={projectName} /> : null}
        <span
          className="min-w-0 flex-1 truncate text-[length:var(--text-caption)] leading-4"
          style={{ color: "var(--app-text-secondary)" }}
          title={projectName ? t("sessionCard.project", { name: projectName }) : undefined}
        >
          {projectName}
        </span>
        {pinned && <Pin className="size-3 shrink-0" style={{ color: "var(--app-text-tertiary)" }} aria-hidden="true" />}
        {sessionCount > 1 && (
          <span className="shrink-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("terminalSplitCount", { count: sessionCount })}
          </span>
        )}
        <SessionStatusGlyph status={status} label={statusLabel} appearance={statusAppearance} />
        {lastActivityAt ? (
          <time
            dateTime={new Date(lastActivityAt).toISOString()}
            title={t("sessionCard.lastActivity", { time: absoluteTime })}
            className="shrink-0 text-[length:var(--text-micro)] tabular-nums leading-none"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {compactRelativeTime(lastActivityAt, now, t("sessionCard.justNow"))}
          </time>
        ) : null}
      </span>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-[length:var(--text-row)] font-medium leading-5"
          style={{ color: "var(--app-text-primary)" }}
        >
          {title}
        </span>
        {engines.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1"
            style={{ color: "var(--app-text-secondary)" }}
            title={t("sessionCard.engines", { list: engineNames })}
            data-engines={engines.join(",")}
          >
            {engines.map((engine) => (
              <CliBrandIcon key={engine} cliTool={engine} className="size-3.5" />
            ))}
          </span>
        )}
      </span>
    </button>
  );
});

export default SessionCard;
