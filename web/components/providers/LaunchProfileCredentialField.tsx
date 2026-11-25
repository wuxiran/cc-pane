// 运行配置的凭证选择：[CLI 自带登录][OAuth 账号][中转站] 分段 + 一个下拉。
// 取代原先「供应商 → 账号」两级下拉（见 launchProfileCredential.ts）。
import { useMemo } from "react";
import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AccountColorDot from "@/components/providers/accounts/AccountColorDot";
import type { LaunchProfileDraft, Provider } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { Button } from "@/components/ui/button";
import { useProvidersStore } from "@/stores";
import { useLoginStatuses, loginStatusKey, type LoginStatusRequest } from "@/hooks/useLoginStatuses";
import {
  DEFAULT_LOGIN_ACCOUNT_ID,
  LOGIN_ACCOUNT_DIR_ENV,
  SYSTEM_PROVIDER_ID,
  type LoginAccountCliTool,
  type LoginAccountStatus,
} from "@/types/provider";
import { loginStatusSummary, type LoginSummaryTone } from "./accounts/loginStatusSummary";
import { HintIcon } from "./launchProfileParts";
import {
  credentialOptions,
  selectedCredential,
  type CredentialKind,
  type CredentialOption,
} from "./launchProfileCredential";

interface LaunchProfileCredentialFieldProps {
  draft: LaunchProfileDraft;
  setDraft: React.Dispatch<React.SetStateAction<LaunchProfileDraft>>;
  providers: Provider[];
  activeTool: KnownCliTool;
  /** 跳到供应商凭证页新增 / 编辑中转站与 OAuth 账号 */
  onManage?: () => void;
}

const TONE_COLOR: Record<LoginSummaryTone, string> = {
  ok: "var(--app-text-tertiary)",
  warn: "var(--app-status-warning)",
  muted: "var(--app-text-tertiary)",
};

function isLoginCli(tool: string): tool is LoginAccountCliTool {
  return Object.prototype.hasOwnProperty.call(LOGIN_ACCOUNT_DIR_ENV, tool);
}

/** 凭证字段下方的一行登录状态（邮箱打码）。还没查到时不占位。 */
function LoginStatusLine({ status, cliTool }: { status?: LoginAccountStatus; cliTool: LoginAccountCliTool }) {
  const { t } = useTranslation("providers");
  if (!status) return null;
  const summary = loginStatusSummary(status, cliTool, t);
  return (
    <p data-testid="credential-login-status" className="text-[length:var(--text-caption)]" style={{ color: TONE_COLOR[summary.tone] }}>
      {summary.text}
    </p>
  );
}

/** 下拉项后缀：只给套餐 / 「未登录」这种短词。 */
function loginStatusSuffix(status: LoginAccountStatus | undefined, t: (key: string) => string): string | null {
  if (!status) return null;
  if (status.state === "logged_in") return status.plan ?? t("providerAccounts.login.state.authenticated");
  if (status.state === "not_logged_in") return t("providerAccounts.login.state.notLoggedIn");
  return null;
}

export default function LaunchProfileCredentialField({ draft, setDraft, providers, activeTool, onManage }: LaunchProfileCredentialFieldProps) {
  const { t } = useTranslation(["providers", "launcher"]);
  const options = useMemo(
    () => credentialOptions(providers, activeTool, t("launcher:account.defaultLogin")),
    [activeTool, providers, t],
  );
  const selected = selectedCredential(options, providers, draft.providerId, draft.providerAccountId);
  const kind: CredentialKind = !draft.providerId ? "cli" : selected?.kind ?? "relay";
  const list = kind === "oauth" ? options.oauth : options.relay;
  // 中转站按智能体筛选：别的智能体的条目这里看不到，说一声免得以为导入丢了
  const allProviders = useProvidersStore((s) => s.providers);
  const otherAgentCount = allProviders.filter((provider) => !providers.some((item) => item.id === provider.id)).length;

  // 登录状态：「CLI 自带登录」查该 CLI 的默认目录；OAuth 段查各登录账号。会话级缓存，不随渲染重查。
  const loginCli = isLoginCli(activeTool) ? activeTool : null;
  const statusRequests = useMemo<LoginStatusRequest[]>(() => {
    if (!loginCli) return [];
    if (kind === "cli") return [{ providerId: SYSTEM_PROVIDER_ID, accountId: DEFAULT_LOGIN_ACCOUNT_ID, cliTool: loginCli }];
    if (kind !== "oauth") return [];
    return options.oauth.flatMap((option) => option.effectiveAccountId
      ? [{ providerId: option.providerId, accountId: option.effectiveAccountId, cliTool: loginCli }]
      : []);
  }, [kind, loginCli, options.oauth]);
  const loginStatuses = useLoginStatuses(statusRequests);
  const oauthStatus = (option: CredentialOption | null | undefined) =>
    loginCli && option?.effectiveAccountId
      ? loginStatuses[loginStatusKey({ providerId: option.providerId, accountId: option.effectiveAccountId, cliTool: loginCli })]
      : undefined;
  const cliStatus = loginCli
    ? loginStatuses[loginStatusKey({ providerId: SYSTEM_PROVIDER_ID, accountId: DEFAULT_LOGIN_ACCOUNT_ID, cliTool: loginCli })]
    : undefined;

  const apply = (option: CredentialOption | null) => setDraft((current) => {
    const providerChanged = (option?.providerId ?? null) !== (current.providerId ?? null);
    const adapterOptions = { ...(current.adapterOptions ?? {}) };
    if (providerChanged && activeTool === "kimi") delete adapterOptions.kimiConfigMode;
    return {
      ...current,
      providerId: option?.providerId ?? null,
      providerAccountId: option?.accountId ?? null,
      // 模型挂在供应商下面：换供应商就回到它的默认模型
      modelId: providerChanged ? null : current.modelId,
      adapterOptions,
    };
  });

  const switchKind = (next: CredentialKind) => {
    if (next === kind) return;
    if (next === "cli") apply(null);
    else apply((next === "oauth" ? options.oauth : options.relay)[0] ?? null);
  };

  const hint = kind === "cli" ? t("credentialCliHint") : kind === "oauth" ? t("credentialOauthHint") : t("credentialRelayHint");

  return (
    <div className="space-y-1.5 md:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-[length:var(--text-caption)] font-medium" style={{ color: "var(--app-text-secondary)" }}>
          {t("fieldCredential")}
          <HintIcon text={hint} />
        </span>
        <SegmentedTabs
          size="sm"
          aria-label={t("fieldCredential")}
          value={kind}
          onValueChange={switchKind}
          items={[
            { value: "cli", label: t("credentialKind.cli") },
            { value: "oauth", label: t("credentialKind.oauth"), disabled: options.oauth.length === 0 },
            { value: "relay", label: t("credentialKind.relay"), disabled: options.relay.length === 0 },
          ]}
        />
        {kind !== "cli" && (
          <div className="min-w-48 flex-1">
            <Select
              value={selected?.key ?? ""}
              onValueChange={(key) => apply(list.find((option) => option.key === key) ?? null)}
            >
              <SelectTrigger aria-label={t(kind === "oauth" ? "credentialKind.oauth" : "credentialKind.relay")}>
                <SelectValue placeholder={draft.providerId ?? ""}>
                  {selected && (
                    <span className="flex items-center gap-1.5">
                      {kind === "oauth" && <AccountColorDot color={selected.color} />}
                      {selected.label}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {list.map((option) => {
                  const suffix = kind === "oauth" ? loginStatusSuffix(oauthStatus(option), t as (key: string) => string) : null;
                  return (
                    <SelectItem key={option.key} value={option.key}>
                      <span className="flex items-center gap-1.5">
                        {kind === "oauth" && <AccountColorDot color={option.color} />}
                        {option.label}
                        {suffix && (
                          <span className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
                            · {suffix}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
        {onManage && (
          <Button size="xs" variant="ghost" onClick={onManage}>
            <Settings2 size={13} /> {t("manageCredentials")}
          </Button>
        )}
        </div>
      </div>
      {loginCli && kind === "cli" && <LoginStatusLine status={cliStatus} cliTool={loginCli} />}
      {loginCli && kind === "oauth" && <LoginStatusLine status={oauthStatus(selected)} cliTool={loginCli} />}
      {/* 两类都没有时才提示一句；只缺一类时那一段置灰即可，不再多一行空态 */}
      {options.oauth.length === 0 && options.relay.length === 0 && (
        <p className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("credentialNoneHint")}
        </p>
      )}
      {kind === "relay" && otherAgentCount > 0 && (
        <p data-testid="relay-other-agents-hint" className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("credentialRelayOtherAgents", { count: list.length, others: otherAgentCount })}
        </p>
      )}
      {selected?.localOnly && (
        <p data-testid="profile-account-local-only-hint" className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("accountLocalOnlyFallback")}
        </p>
      )}
    </div>
  );
}
