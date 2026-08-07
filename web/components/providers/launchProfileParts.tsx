import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardIcon, CardTitle } from "@/components/ui/card";

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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5 text-xs">
      <span className="font-medium" style={{ color: "var(--app-text-secondary)" }}>{label}</span>
      {children}
    </label>
  );
}

/** 设置块软卡片（docs/46 §6）：中性图标底 + 标题/描述 + 可选头部动作 */
export function Section({
  title,
  description,
  icon,
  headerActions,
  children,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardIcon>{icon}</CardIcon>
        <div className="min-w-0 flex-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {headerActions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** 概要卡 summary strip 的单项：11px 大写元信息在上、13px 值在下（docs/46 §5） */
export function SummaryStat({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-1 last:pr-1">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em]" style={{ color: "var(--app-text-tertiary)" }}>
        {label}
      </div>
      <div className="mt-0.5 truncate text-[13px]" style={{ color: "var(--app-text-primary)" }}>{value}</div>
      {meta && (
        <div className="truncate text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>{meta}</div>
      )}
    </div>
  );
}
