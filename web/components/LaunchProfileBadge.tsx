// 会话里只读显示「当前用的运行配置」：终端状态栏与 Agent Chat 会话头共用。
// 纯展示——不提供切换（运行配置只在会话启动时生效）。hover 给出配置名 + 凭证类型 + 模型。
import { useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  describeLaunchProfile,
  type LaunchCredentialDisplay,
  type LaunchProfileDisplay,
  type LaunchProfileSessionInput,
} from "@/lib/launchProfileDisplay";
import { cn } from "@/lib/utils";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import type { LaunchProfile } from "@/types/launch-profile";
import type { Provider } from "@/types/provider";
import { handleErrorSilent } from "@/utils/errorHandler";

interface LaunchProfileBadgeProps {
  session: LaunchProfileSessionInput;
  /** terminal：空 id 回落默认配置并显示「默认」；chat：空 id 即系统默认，不显示。 */
  mode: "terminal" | "chat";
  className?: string;
}

const NO_PROFILES: LaunchProfile[] = [];
const NO_PROVIDERS: Provider[] = [];

type Translate = (key: string, options?: Record<string, string | undefined>) => string;

function credentialLabel(credential: LaunchCredentialDisplay | null, t: Translate): string {
  if (!credential) return t("launchProfileBadgeUnknownValue");
  switch (credential.kind) {
    case "cli":
      return t("launchProfileBadgeCredentialCli");
    case "login":
      return t("launchProfileBadgeCredentialLogin", { name: credential.name });
    case "relay":
      return credential.accountName
        ? t("launchProfileBadgeCredentialRelayAccount", { name: credential.name, account: credential.accountName })
        : t("launchProfileBadgeCredentialRelay", { name: credential.name });
    case "missingRelay":
      return t("launchProfileBadgeCredentialMissing");
  }
}

function badgeLabel(display: LaunchProfileDisplay, t: Translate): string {
  if (display.kind === "deleted") {
    return display.name ? t("launchProfileBadgeDeletedNamed", { name: display.name }) : t("launchProfileBadgeDeleted");
  }
  if (display.kind === "systemDefault") return t("launchProfileBadgeDefault");
  return display.name ?? t("launchProfileBadgeDefault");
}

function profileLine(display: LaunchProfileDisplay, t: Translate): string {
  if (display.kind === "implicitDefault") return t("launchProfileBadgeImplicitDefault", { name: display.name });
  if (display.kind === "systemDefault") return t("launchProfileBadgeSystemDefault");
  return badgeLabel(display, t);
}

/** 运行配置还没加载过时补一次（独立窗口 / 弹出窗口不经主窗口生命周期）。 */
function useEnsureLaunchProfilesLoaded(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const state = useLaunchProfilesStore.getState();
    if (state.loaded || state.loading) return;
    void state.load().catch((error) => handleErrorSilent(error, "load launch profiles for badge"));
  }, [enabled]);
}

export default function LaunchProfileBadge({ session, mode, className }: LaunchProfileBadgeProps) {
  const { t: rawT } = useTranslation("panes");
  const t: Translate = (key, options) => String(rawT(key as never, options as never));
  // 加载失败或旧数据可能留下非数组，兜成空表（只读展示不该把状态栏带崩）。
  const profiles = useLaunchProfilesStore((state) => state.profiles) ?? NO_PROFILES;
  const profilesLoaded = useLaunchProfilesStore((state) => state.loaded);
  const providers = useProvidersStore((state) => state.providers) ?? NO_PROVIDERS;
  const cliTool = session.cliTool?.trim().toLowerCase();
  const hasProfileId = Boolean(session.launchProfileId?.trim() || session.launchProfileSnapshot?.launchProfileId);
  // 普通 shell 没有运行配置；Chat 只在会话确实记了配置时显示（空 = 系统默认，引擎也可能根本不支持）。
  const applicable = mode === "terminal" ? Boolean(cliTool && cliTool !== "none") : hasProfileId;
  useEnsureLaunchProfilesLoaded(applicable);
  if (!applicable) return null;

  const display = describeLaunchProfile(session, { profiles, profilesLoaded, providers, mode });
  if (display.kind === "unknown") return null;
  const label = badgeLabel(display, t);
  const muted = display.kind === "systemDefault" || display.kind === "deleted";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-testid="launch-profile-badge"
          data-kind={display.kind}
          aria-label={t("launchProfileBadgeAria", { name: label })}
          className={cn(
            "flex min-w-0 shrink items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
            muted ? "text-[var(--app-text-tertiary)]" : "text-[var(--app-text-secondary)]",
            className,
          )}
        >
          <SlidersHorizontal className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-left">
        <dl data-testid="launch-profile-badge-tooltip" className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <dt className="opacity-70">{t("launchProfileBadgeTitle")}</dt>
          <dd className="break-words">{profileLine(display, t)}</dd>
          <dt className="opacity-70">{t("launchProfileBadgeCredential")}</dt>
          <dd className="break-words">{credentialLabel(display.credential, t)}</dd>
          <dt className="opacity-70">{t("launchProfileBadgeModel")}</dt>
          <dd className="break-words">{display.model ?? t("launchProfileBadgeModelDefault")}</dd>
        </dl>
        <p className="mt-1 opacity-70">{t("launchProfileBadgeReadOnly")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
