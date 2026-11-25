// 启动页「运行配置」下拉：放在合并选择器 chip 旁边。首项「系统默认」= 不托管，
// 引擎用 CLI 自己的登录与配置（今天的行为）；其后只列目标 CLI 匹配的运行配置。
// 运行配置只在会话启动时生效（菜单底部说明），进行中的会话不在这里改。
import { useEffect } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import type { LaunchProfile } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";

export interface ChatLaunchProfileMenuProps {
  /** 选中引擎可接收的 CLI（codex / claude）；undefined = 此引擎不支持运行配置。 */
  cli?: string;
  /** 远程（SSH）会话不支持运行配置。 */
  remote: boolean;
  /** null = 系统默认。 */
  value: string | null;
  onChange: (launchProfileId: string | null) => void;
  disabled?: boolean;
}

/** 目标 CLI 匹配的运行配置（targetTools 为空 = 通用）。 */
export function compatibleLaunchProfiles(profiles: readonly LaunchProfile[], cli: string | undefined): LaunchProfile[] {
  if (!cli) return [];
  return profiles.filter((profile) => profile.targetTools.length === 0 || profile.targetTools.includes(cli));
}

export default function ChatLaunchProfileMenu({ cli, remote, value, onChange, disabled }: ChatLaunchProfileMenuProps) {
  const { t } = useTranslation("panes");
  const profiles = useLaunchProfilesStore((state) => state.profiles);
  const supported = Boolean(cli) && !remote;

  useEffect(() => {
    if (!supported || useLaunchProfilesStore.getState().profiles.length > 0) return;
    void useLaunchProfilesStore.getState().load()
      .catch((error) => handleErrorSilent(error, "load launch profiles for agent chat"));
  }, [supported]);

  const options = supported ? compatibleLaunchProfiles(profiles, cli) : [];
  const current = options.find((profile) => profile.id === value) ?? null;
  const label = current?.name ?? t("agentChatLaunchProfileDefault");
  const note = !cli ? t("agentChatLaunchProfileUnsupported")
    : remote ? t("agentChatLaunchProfileRemote")
      : options.length === 0 ? t("agentChatLaunchProfileEmpty") : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="chat-launch-profile"
          aria-label={t("agentChatLaunchProfileAria", { name: label })}
          title={t("agentChatLaunchProfile")}
          className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-transparent px-2 text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:pointer-events-none disabled:opacity-50"
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="max-w-32 truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          {t("agentChatLaunchProfileDefault")}
          {current === null ? <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span> : null}
        </DropdownMenuItem>
        {options.map((profile) => (
          <DropdownMenuItem key={profile.id} title={profile.description ?? undefined} onSelect={() => onChange(profile.id)}>
            <span className="max-w-48 truncate">{profile.name}</span>
            {profile.id === current?.id ? <span className="ml-auto pl-3 text-[var(--app-accent)]">✓</span> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p role="note" className="px-2 py-1.5 text-[length:var(--text-caption)] leading-snug text-[var(--app-text-tertiary)]">
          {note ?? t("agentChatLaunchProfileHint")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
