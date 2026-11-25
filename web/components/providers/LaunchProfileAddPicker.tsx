// 运行配置 MCP / Skill 卡共用的「新增」选择器：从已有资源里勾选开给本配置，底部放次要动作。
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface AddPickerItem {
  key: string;
  name: string;
  description?: string | null;
  checked: boolean;
}

export interface AddPickerGroup {
  label?: string;
  items: AddPickerItem[];
}

/** 条目少时一眼扫完比搜索快，超过才出现搜索框（与资源库同阈值） */
const SEARCH_THRESHOLD = 8;

interface AddPickerProps {
  testId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: AddPickerGroup[];
  onToggle: (key: string, on: boolean) => void;
  /** 整体不可选时的说明（如该类资源被设为不注入） */
  disabledNote?: string | null;
  emptyText: string;
  /** 列表下方的补充说明 */
  footnote?: string | null;
  footer: ReactNode;
}

export default function AddPicker({
  testId,
  title,
  open,
  onOpenChange,
  groups,
  onToggle,
  disabledNote,
  emptyText,
  footnote,
  footer,
}: AddPickerProps) {
  const { t } = useTranslation("providers");
  const [query, setQuery] = useState("");
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const needle = query.trim().toLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      items: needle
        ? group.items.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle))
        : group.items,
    }))
    .filter((group) => group.items.length > 0);

  return (
    <Popover open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" className="h-7 px-2" data-testid={`${testId}-trigger`}>
          <Plus size={12} /> {t("add")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid={testId}>
        <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {title}
        </div>
        {disabledNote && (
          <div className="px-3 pt-2 text-xs" style={{ color: "var(--app-status-warning)" }} role="note">
            {disabledNote}
          </div>
        )}
        {total > SEARCH_THRESHOLD && (
          <div className="relative px-3 pt-2">
            <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-5 top-1/2 mt-1 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("profileAdd.search")}
              aria-label={t("profileAdd.search")}
              className="h-7 pl-6 text-xs"
            />
          </div>
        )}
        <div className="app-scrollbar max-h-64 overflow-y-auto px-1.5 py-1.5">
          {total === 0 ? (
            <div className="px-1.5 py-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{emptyText}</div>
          ) : visible.length === 0 ? (
            <div className="px-1.5 py-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("profileAdd.noMatch")}</div>
          ) : visible.map((group) => (
            <div key={group.label ?? "_"} className="py-0.5">
              {group.label && (
                <div className="px-1.5 pb-0.5 pt-1 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
                  {group.label}
                </div>
              )}
              {group.items.map((item) => (
                <label
                  key={item.key}
                  className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--app-hover)] has-[button:disabled]:cursor-default has-[button:disabled]:opacity-60"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={item.checked}
                    disabled={Boolean(disabledNote)}
                    aria-label={item.name}
                    onCheckedChange={(next) => onToggle(item.key, next === true)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs" style={{ color: "var(--app-text-primary)" }}>{item.name}</span>
                    {item.description && (
                      <span className="block truncate text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
                        {item.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
        {footnote && (
          <div className="px-3 pb-1.5 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>{footnote}</div>
        )}
        <div className="flex flex-wrap items-center gap-1 border-t border-[var(--app-border)] px-2 py-1.5">{footer}</div>
      </PopoverContent>
    </Popover>
  );
}

/** 卡片里「新增了、保存后才生效」的条目，接在「将注入」那行下面 */
export function PendingAdditions({ names, testId }: { names: readonly string[]; testId: string }) {
  const { t } = useTranslation("providers");
  if (names.length === 0) return null;
  return (
    <div data-testid={testId} className="mt-1 flex flex-wrap items-center gap-1 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
      <span className="mr-0.5">{t("profileAdd.pending")}</span>
      {names.map((name) => (
        <span
          key={name}
          className="rounded border border-dashed border-[var(--app-accent)] px-1.5 leading-5"
          style={{ color: "var(--app-text-secondary)" }}
        >
          + {name}
        </span>
      ))}
    </div>
  );
}
