// 权限自动放行多选下拉（启动页与会话 composer 共用）：按工具类别勾选，
// 命中的 session/request_permission 不再弹审批卡。菜单勾选后保持打开，
// 方便一次勾多项。
import { ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PERMISSION_GROUPS,
  enabledGroupCount,
  isAutoApproveAll,
  isGroupEnabled,
  toggleAll,
  toggleGroup,
} from "./permissionPolicy";

export interface PermissionPolicyDropdownProps {
  kinds: string[];
  onChange: (kinds: string[]) => void;
  disabled?: boolean;
}

export default function PermissionPolicyDropdown({
  kinds,
  onChange,
  disabled,
}: PermissionPolicyDropdownProps) {
  const { t } = useTranslation("panes");
  const all = isAutoApproveAll(kinds);
  const count = enabledGroupCount(kinds);

  const Icon = all ? ShieldAlert : count > 0 ? ShieldCheck : Shield;
  const label = all
    ? t("agentChatPermAll")
    : count > 0
      ? t("agentChatPermSome", { count })
      : t("agentChatPermDefault");
  // 全放行是需要注意的状态（琥珀），部分放行是激活态（accent），默认中性。
  const tone = all
    ? "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] text-[var(--app-status-warning)]"
    : count > 0
      ? "border-[var(--app-accent)]/40 bg-[var(--app-active-bg)] text-[var(--app-accent)]"
      : "border-transparent text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t("agentChatPermTitle")}
          className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:opacity-50 ${tone}`}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-32 truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-tertiary)]">
          {t("agentChatPermTitle")}
        </DropdownMenuLabel>
        <div className="px-2 pb-1.5 text-[11px] leading-snug text-[var(--app-text-tertiary)]">
          {t("agentChatPermHint")}
        </div>
        <DropdownMenuSeparator />
        {PERMISSION_GROUPS.map((group) => (
          <DropdownMenuCheckboxItem
            key={group.id}
            checked={isGroupEnabled(kinds, group)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onChange(toggleGroup(kinds, group))}
            className="text-xs"
          >
            <span className="flex-1">{t(group.labelKey)}</span>
            <span className="font-mono text-[10px] text-[var(--app-text-tertiary)]">
              {group.kinds.join(" · ")}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={all}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => onChange(toggleAll(kinds))}
          className="text-xs"
        >
          <span className="flex-1 text-[var(--app-status-warning)]">{t("agentChatPermAll")}</span>
          <ShieldAlert className="size-3.5 text-[var(--app-status-warning)]" />
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
