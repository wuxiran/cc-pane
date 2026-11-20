// 权限下拉（启动页与会话 composer 共用）：三档预设——请求批准 / 帮我批准 / 完全访问。
// 选「完全访问」先过一个确认对话框，说清楚它放开了什么。逐类勾选收在「自定义」里。
import { useState } from "react";
import {
  Check, ChevronDown, Folder, Globe, Hand, ShieldAlert, ShieldCheck, SlidersHorizontal, SquareTerminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PERMISSION_GROUPS,
  enabledGroupCount,
  isAutoApproveAll,
  isGroupEnabled,
  presetKinds,
  presetOf,
  toggleGroup,
  type PermissionPresetId,
} from "./permissionPolicy";

export interface PermissionPolicyDropdownProps {
  kinds: string[];
  onChange: (kinds: string[]) => void;
  disabled?: boolean;
}

type PresetLabelKey = "agentChatPermAsk" | "agentChatPermAssist" | "agentChatPermFull";
type PresetHintKey = "agentChatPermAskHint" | "agentChatPermAssistHint" | "agentChatPermFullHint";

const PRESETS: readonly { id: PermissionPresetId; icon: LucideIcon; labelKey: PresetLabelKey; hintKey: PresetHintKey }[] = [
  { id: "ask", icon: Hand, labelKey: "agentChatPermAsk", hintKey: "agentChatPermAskHint" },
  { id: "assist", icon: ShieldCheck, labelKey: "agentChatPermAssist", hintKey: "agentChatPermAssistHint" },
  { id: "full", icon: ShieldAlert, labelKey: "agentChatPermFull", hintKey: "agentChatPermFullHint" },
];

const FULL_ACCESS_GRANTS = [
  { icon: Folder, titleKey: "agentChatPermFullFiles", hintKey: "agentChatPermFullFilesHint" },
  { icon: SquareTerminal, titleKey: "agentChatPermFullCommands", hintKey: "agentChatPermFullCommandsHint" },
  { icon: Globe, titleKey: "agentChatPermFullNetwork", hintKey: "agentChatPermFullNetworkHint" },
] as const;

export default function PermissionPolicyDropdown({ kinds, onChange, disabled }: PermissionPolicyDropdownProps) {
  const { t } = useTranslation(["panes", "common"]);
  const [confirmingFull, setConfirmingFull] = useState(false);
  const preset = presetOf(kinds);
  const current = PRESETS.find((item) => item.id === preset);

  const TriggerIcon = current?.icon ?? SlidersHorizontal;
  const triggerLabel = current
    ? t(current.id === "full" ? "agentChatPermFullShort" : current.labelKey)
    : t("agentChatPermCustomCount", { count: enabledGroupCount(kinds) });
  // 完全访问是需要一直看得见的状态（琥珀底）；其余两档和自定义保持中性。
  const tone = preset === "full"
    ? "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] text-[var(--app-status-warning)]"
    : "border-transparent text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]";

  const choose = (id: PermissionPresetId) => {
    if (id === preset) return;
    if (id === "full") setConfirmingFull(true);
    else onChange(presetKinds(id));
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("agentChatPermTitle")}
            className={`flex h-7 min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors disabled:opacity-50 ${tone}`}
          >
            <TriggerIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-32 truncate">{triggerLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[300px] rounded-xl p-1.5">
          <DropdownMenuLabel className="px-2 pb-1.5 pt-1 text-[length:var(--text-small)] font-normal text-[var(--app-text-tertiary)]">
            {t("agentChatPermQuestion")}
          </DropdownMenuLabel>
          {PRESETS.map(({ id, icon: Icon, labelKey, hintKey }) => {
            const danger = id === "full";
            const selected = id === preset;
            return (
              <DropdownMenuItem
                key={id}
                data-testid={`permission-preset-${id}`}
                aria-checked={selected}
                className="items-start gap-2.5 rounded-lg px-2 py-2"
                onSelect={() => choose(id)}
              >
                <Icon className={`mt-0.5 size-4 shrink-0 ${danger ? "text-[var(--app-status-warning)]" : "text-[var(--app-text-secondary)]"}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[length:var(--text-row)] ${danger ? "text-[var(--app-status-warning)]" : "text-[var(--app-text-primary)]"}`}>
                    {t(labelKey)}
                  </span>
                  <span className={`block text-[length:var(--text-caption)] leading-snug ${danger ? "text-[var(--app-status-warning)]" : "text-[var(--app-text-tertiary)]"}`}>
                    {t(hintKey)}
                  </span>
                </span>
                {selected && <Check className={`mt-0.5 size-4 shrink-0 ${danger ? "text-[var(--app-status-warning)]" : "text-[var(--app-text-secondary)]"}`} />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2.5 rounded-lg px-2 py-1.5 text-[length:var(--text-row)]">
              <SlidersHorizontal className="size-4 shrink-0 text-[var(--app-text-secondary)]" />
              <span className="flex-1">{t("agentChatPermCustom")}</span>
              {!preset && <Check className="size-4 shrink-0 text-[var(--app-text-secondary)]" />}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="text-[length:var(--text-caption)] font-normal leading-snug text-[var(--app-text-tertiary)]">
                {t("agentChatPermCustomHint")}
              </DropdownMenuLabel>
              {PERMISSION_GROUPS.map((group) => (
                <DropdownMenuCheckboxItem
                  key={group.id}
                  checked={isGroupEnabled(kinds, group)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => {
                    const next = toggleGroup(kinds, group);
                    // 把最后一类也勾上就等于完全访问：同样先确认，不能从自定义里悄悄绕过去。
                    if (isAutoApproveAll(next)) setConfirmingFull(true);
                    else onChange(next);
                  }}
                  className="text-xs"
                >
                  {t(group.labelKey)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmingFull} onOpenChange={setConfirmingFull}>
        <AlertDialogContent className="sm:max-w-md" data-testid="permission-full-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 shrink-0 text-[var(--app-status-warning)]" aria-hidden="true" />
              {t("agentChatPermFullConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("agentChatPermFullConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="divide-y divide-[var(--app-border)] rounded-xl bg-[var(--app-hover)] px-3">
            {FULL_ACCESS_GRANTS.map(({ icon: Icon, titleKey, hintKey }) => (
              <li key={titleKey} className="flex items-start gap-3 py-2.5">
                <Icon className="mt-0.5 size-5 shrink-0 text-[var(--app-accent)]" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">{t(titleKey)}</span>
                  <span className="block text-[length:var(--text-caption)] leading-snug text-[var(--app-text-tertiary)]">{t(hintKey)}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[length:var(--text-small)] leading-snug text-[var(--app-text-tertiary)]">{t("agentChatPermFullConfirmRisk")}</p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel", { ns: "common" })}</AlertDialogCancel>
            <AlertDialogAction
              className="border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] text-[var(--app-status-warning)] hover:bg-[var(--app-status-warning-bg)] hover:brightness-110"
              onClick={() => onChange(presetKinds("full"))}
            >
              <ShieldAlert className="size-4" aria-hidden="true" /> {t("confirm", { ns: "common" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
