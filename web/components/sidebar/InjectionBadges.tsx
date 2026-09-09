// 「MCP · Skill · 记忆」三个小标：on 正常、partial 半透明加 ◐、off 划掉。悬停看原因。
import { useTranslation } from "react-i18next";
import type { InjectionState, InjectionSummary } from "./launchInjectionSummary";

const MARK: Record<InjectionState, string> = { on: "", partial: "◐", off: "✕" };

export default function InjectionBadges({ summary, className }: { summary: InjectionSummary; className?: string }) {
  const { t } = useTranslation("sidebar");
  const items: Array<{ key: keyof InjectionSummary["reasons"]; label: string; state: InjectionState }> = [
    { key: "mcp", label: "MCP", state: summary.mcp },
    { key: "skills", label: "Skill", state: summary.skills },
    { key: "memory", label: t("injection.memoryLabel"), state: summary.memory },
  ];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] ${className ?? ""}`} data-testid="injection-badges">
      {items.map((item) => (
        <span
          key={item.key}
          title={t(summary.reasons[item.key] as never)}
          data-state={item.state}
          className={item.state === "off" ? "line-through" : undefined}
          style={{
            color: item.state === "on" ? "var(--app-text-secondary)" : "var(--app-text-tertiary)",
            opacity: item.state === "off" ? 0.55 : 1,
          }}
        >
          {MARK[item.state] && <span className="mr-0.5">{MARK[item.state]}</span>}
          {item.label}
        </span>
      ))}
    </span>
  );
}
