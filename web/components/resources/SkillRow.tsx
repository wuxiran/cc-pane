// 技能页的一行：名称 + 状态标签、单行描述、来源行、悬停操作，末尾一排启动档开关。点行看详情。
import type { ReactNode } from "react";

export type SkillTagTone = "warn" | "accent" | "muted";

export interface SkillRowTag {
  key: string;
  label: string;
  tone: SkillTagTone;
  /** 标签的完整含义，读屏和悬停都能看到；行内已有足够信息时可省略 */
  title?: string;
}

const TAG_STYLE: Record<SkillTagTone, React.CSSProperties> = {
  warn: { color: "var(--app-status-warning, var(--app-text-secondary))", borderColor: "color-mix(in srgb, var(--app-status-warning, var(--app-border)) 45%, transparent)" },
  accent: { color: "var(--app-accent)", borderColor: "color-mix(in srgb, var(--app-accent) 45%, transparent)" },
  muted: { color: "var(--app-text-tertiary)", borderColor: "var(--app-border)" },
};

interface SkillRowProps {
  name: string;
  /** 方便测试和定位：资源库技能是 id，其余是名字 */
  rowKey: string;
  tags?: readonly SkillRowTag[];
  description?: string | null;
  source?: ReactNode;
  current: boolean;
  onSelect?: () => void;
  /** 悬停才出现的操作按钮（更新、删除） */
  actions?: ReactNode;
  notice?: string | null;
  trailing?: ReactNode;
  testId?: string;
}

export default function SkillRow({
  name,
  rowKey,
  tags = [],
  description,
  source,
  current,
  onSelect,
  actions,
  notice,
  trailing,
  testId = "skill-library-row",
}: SkillRowProps) {
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>{name}</span>
        {tags.map((tag) => (
          <span
            key={tag.key}
            title={tag.title}
            data-tag={tag.key}
            className="rounded-full border px-1.5 text-[length:var(--text-micro)] leading-4"
            style={TAG_STYLE[tag.tone]}
          >
            {tag.label}
          </span>
        ))}
      </span>
      {description && <span className="mt-0.5 block truncate text-[length:var(--text-small)]" style={{ color: "var(--app-text-secondary)" }} title={description}>{description}</span>}
      {source && <span className="mt-0.5 block truncate font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{source}</span>}
      {notice && <span role="status" className="mt-0.5 block text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }}>{notice}</span>}
    </>
  );
  return (
    <div
      className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] data-[current=true]:bg-[var(--app-active-bg)]"
      data-testid={testId}
      data-resource-name={rowKey}
      data-current={current ? "true" : undefined}
    >
      {onSelect ? (
        <button type="button" aria-expanded={current} className="min-w-48 flex-1 text-left" onClick={onSelect}>{body}</button>
      ) : (
        <div className="min-w-48 flex-1">{body}</div>
      )}
      {actions && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">{actions}</div>
      )}
      {trailing}
    </div>
  );
}
