import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SettingsPaneDefinition, SettingsPaneId } from "./settingsRegistry";

interface SettingsPaneAccordionProps {
  panes: readonly SettingsPaneDefinition[];
  /** 当前展开的分段；null = 全部收起。同一时间只展开一段，内容只挂载这一段。 */
  expandedPaneId: SettingsPaneId | null;
  onToggle: (paneId: SettingsPaneId) => void;
  /** 展开段的正文（由父级渲染，保持草稿/未保存守卫等逻辑在父级） */
  children: ReactNode;
}

/**
 * 设置页内的分段折叠：一页多个分段时纵向堆叠，点击标题在原地往下展开，
 * 不再在顶栏切标签。wide 分段（运行配置/供应商凭证）展开后占满剩余高度，
 * 自己管理内部滚动；普通分段按内容高度展开、超出时段内滚动。
 * wide 分段有最小高度（520px）：窗口矮、分段多时不把正文压成一小条，
 * 放不下就让整个分段列表滚动。
 */
export default function SettingsPaneAccordion({
  panes,
  expandedPaneId,
  onToggle,
  children,
}: SettingsPaneAccordionProps) {
  const { t } = useTranslation("settings");

  return (
    <div
      role="group"
      aria-label={t("paneNavigation")}
      data-testid="settings-pane-accordion"
      className="app-scrollbar flex h-full min-h-0 flex-col gap-2 overflow-y-auto py-4"
    >
      {panes.map((pane) => {
        const expanded = pane.id === expandedPaneId;
        const Icon = pane.icon;
        const bodyId = `settings-pane-body-${pane.id}`;
        const wide = pane.layout === "wide";
        return (
          <section
            key={pane.id}
            data-pane-id={pane.id}
            data-expanded={expanded ? "true" : undefined}
            className={cn(
              "shape-panel flex min-h-0 flex-col overflow-hidden rounded-lg border bg-[var(--app-panel-bg)] transition-colors duration-[var(--dur-fast)]",
              expanded
                ? cn("border-[var(--app-border-strong,var(--app-border))] shadow-sm", wide ? "min-h-[520px] flex-1" : "shrink")
                : "shrink-0 border-[var(--app-border)] hover:border-[var(--app-border-strong,var(--app-border))]",
            )}
          >
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              onClick={() => onToggle(pane.id)}
              className={cn(
                "group flex w-full shrink-0 items-center gap-3 px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]",
                expanded && "border-b border-[var(--app-border)]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
                  expanded
                    ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]"
                    : "bg-[var(--app-hover)] text-[var(--app-text-secondary)] group-hover:text-[var(--app-text-primary)]",
                )}
              >
                <Icon size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className={cn(
                    "truncate text-[length:var(--text-body)] font-medium",
                    expanded ? "text-[var(--app-text-primary)]" : "text-[var(--app-text-secondary)] group-hover:text-[var(--app-text-primary)]",
                  )}
                >
                  {t(pane.titleKey)}
                </span>
                {pane.descriptionKey && (
                  <span className="truncate text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                    {t(pane.descriptionKey)}
                  </span>
                )}
              </span>
              <ChevronDown
                aria-hidden="true"
                size={16}
                className={cn(
                  "shrink-0 text-[var(--app-text-tertiary)] transition-transform duration-[var(--dur-fast)]",
                  expanded ? "rotate-0 text-[var(--app-text-secondary)]" : "-rotate-90",
                )}
              />
            </button>
            {expanded && (
              <div
                id={bodyId}
                data-testid="settings-pane-body"
                className={cn(
                  "min-h-0 flex-1 animate-in fade-in-0 slide-in-from-top-1 duration-200",
                  wide ? "overflow-hidden px-4" : "overflow-y-auto px-5 py-5",
                )}
              >
                {children}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
