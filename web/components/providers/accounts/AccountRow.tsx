import { useTranslation } from "react-i18next";
import { Check, LogIn, Pencil, RefreshCw, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import type { LoginAccountCliTool, LoginAccountStatus } from "@/types/provider";
import AccountColorDot from "./AccountColorDot";
import AccountColorPicker from "./AccountColorPicker";
import EnvVarsEditor from "./EnvVarsEditor";
import { secretDisplay, type AccountDraft } from "./drafts";

export function LoginStatusText({ status, checking }: { status?: LoginAccountStatus; checking?: boolean }) {
  const { t } = useTranslation("providers");
  if (checking) return <span>{t("providerAccounts.login.checking")}</span>;
  if (!status) return <span>{t("providerAccounts.login.state.unknown")}</span>;
  if (status.state === "logged_in") {
    return (
      <span style={{ color: "var(--app-status-success, var(--app-text-secondary))" }}>
        {status.identity
          ? t("providerAccounts.login.state.loggedInAs", { identity: status.identity })
          : t("providerAccounts.login.state.loggedIn")}
      </span>
    );
  }
  if (status.state === "not_logged_in") {
    return <span style={{ color: "var(--app-status-warning)" }}>{t("providerAccounts.login.state.notLoggedIn")}</span>;
  }
  const reasonKey = status.reason && KNOWN_REASONS.has(status.reason) ? status.reason as UnknownReason : null;
  return (
    <span title={reasonKey ? t(`providerAccounts.login.reason.${reasonKey}`) : undefined}>
      {t("providerAccounts.login.state.unknown")}
      {reasonKey && <span className="ml-1 opacity-80">· {t(`providerAccounts.login.reason.${reasonKey}`)}</span>}
    </span>
  );
}

type UnknownReason =
  | "keychain_unavailable"
  | "antigravity_reports_in_cli"
  | "credential_file_missing"
  | "account_file_unreadable"
  | "home_unavailable"
  | "unsupported_cli";

const KNOWN_REASONS = new Set<string>([
  "keychain_unavailable",
  "antigravity_reports_in_cli",
  "credential_file_missing",
  "account_file_unreadable",
  "home_unavailable",
  "unsupported_cli",
]);

interface AccountRowProps {
  /** 落盘账号的草稿；合成的「默认登录」没有。 */
  draft?: AccountDraft;
  /** 登录账号：CLI（默认登录也有）。 */
  cliTool?: LoginAccountCliTool | null;
  loginStatus?: LoginAccountStatus;
  isDefault: boolean;
  editing: boolean;
  checking: boolean;
  onToggleEdit?: () => void;
  onChange?: (patch: Partial<AccountDraft>) => void;
  onSetDefault?: () => void;
  onDelete?: () => void;
  onRecheck?: () => void;
  onRelogin?: () => void;
}

export default function AccountRow({
  draft,
  cliTool,
  loginStatus,
  isDefault,
  editing,
  checking,
  onToggleEdit,
  onChange,
  onSetDefault,
  onDelete,
  onRecheck,
  onRelogin,
}: AccountRowProps) {
  const { t } = useTranslation("providers");
  const isDefaultLogin = !draft;
  const isLogin = isDefaultLogin || draft.kind === "login";
  const name = draft ? draft.name : t("providerAccounts.account.defaultLogin");
  const secretState = draft && draft.kind === "api_key" ? secretDisplay(draft) : null;

  return (
    <div
      data-testid={`provider-account-row-${draft?.id ?? `default-login-${cliTool}`}`}
      className="rounded-lg border"
      style={{ borderColor: "var(--app-border)", background: "var(--app-panel-bg)" }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <AccountColorDot color={draft?.color} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
              {name || t("providerAccounts.account.unnamed")}
            </span>
            {isDefault && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[length:var(--text-nano)]">
                {t("providerAccounts.account.defaultBadge")}
              </Badge>
            )}
            {draft?.isNew && (
              <Badge variant="outline" className="px-1.5 py-0 text-[length:var(--text-nano)]">
                {t("providerAccounts.account.unsaved")}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
            <span>{isLogin ? t("providerAccounts.account.kindLogin") : t("providerAccounts.account.kindKey")}</span>
            {isLogin && cliTool && (
              <>
                <span className="opacity-40">·</span>
                <span>{t(`providerAccounts.cli.${cliTool}`)}</span>
                <span className="opacity-40">·</span>
                <LoginStatusText status={loginStatus} checking={checking} />
              </>
            )}
            {secretState && (
              <>
                <span className="opacity-40">·</span>
                {secretState !== "none" && secretState !== "pending" && <span className="font-mono">••••</span>}
                <span>{t(`providerAccounts.account.secretState.${secretState}`)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {isLogin && onRecheck && (
            <IconTooltipButton label={t("providerAccounts.login.recheck")} className="h-7 w-7" disabled={checking} onClick={onRecheck}>
              <RefreshCw size={13} />
            </IconTooltipButton>
          )}
          {isLogin && onRelogin && (
            <IconTooltipButton label={t("providerAccounts.login.relogin")} className="h-7 w-7" onClick={onRelogin}>
              <LogIn size={13} />
            </IconTooltipButton>
          )}
          {!isDefault && onSetDefault && (
            <IconTooltipButton label={t("providerAccounts.account.setDefault")} className="h-7 w-7" onClick={onSetDefault}>
              <Star size={13} />
            </IconTooltipButton>
          )}
          {onToggleEdit && (
            <IconTooltipButton
              label={editing ? t("providerAccounts.account.done") : t("providerAccounts.account.edit", { name })}
              className="h-7 w-7"
              aria-expanded={editing}
              onClick={onToggleEdit}
            >
              {editing ? <Check size={13} /> : <Pencil size={13} />}
            </IconTooltipButton>
          )}
          {onDelete && (
            <IconTooltipButton
              label={t("providerAccounts.account.delete", { name })}
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 size={13} />
            </IconTooltipButton>
          )}
        </div>
      </div>
      {isDefaultLogin && (
        <p className="px-3 pb-2 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("providerAccounts.account.defaultLoginHint")}
        </p>
      )}
      {draft && editing && onChange && <AccountEditor draft={draft} onChange={onChange} />}
    </div>
  );
}

function AccountEditor({ draft, onChange }: { draft: AccountDraft; onChange: (patch: Partial<AccountDraft>) => void }) {
  const { t } = useTranslation("providers");
  const nameId = `provider-account-name-${draft.id}`;
  const secretId = `provider-account-secret-${draft.id}`;
  const hasStored = draft.secretStorage !== "none";
  return (
    <div className="flex flex-col gap-3 border-t px-3 py-3" style={{ borderColor: "var(--app-border)" }}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={nameId} className="text-xs font-medium">{t("providerAccounts.account.name")}</Label>
        <Input
          id={nameId}
          className="h-9 text-sm"
          maxLength={128}
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={t("providerAccounts.account.namePlaceholder")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">{t("providerAccounts.account.color")}</span>
        <AccountColorPicker value={draft.color} onChange={(color) => onChange({ color })} />
      </div>
      {draft.kind === "api_key" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={secretId} className="text-xs font-medium">
            {hasStored ? t("providerAccounts.account.secretReplace") : t("providerAccounts.account.secret")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={secretId}
              className="h-9 text-sm"
              type="password"
              autoComplete="off"
              value={draft.secret}
              onChange={(event) => onChange({ secret: event.target.value })}
              placeholder={hasStored
                ? t("providerAccounts.account.secretStoredPlaceholder")
                : t("providerAccounts.account.secretNewPlaceholder")}
            />
            {hasStored && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => onChange({ secret: "", secretStorage: "none" })}
              >
                {t("providerAccounts.account.clearSecret")}
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">{t("providerAccounts.account.env")}</span>
        <p className="text-[length:var(--text-caption)] leading-4" style={{ color: "var(--app-text-secondary)" }}>
          {t("providerAccounts.account.envHint")}
        </p>
        <EnvVarsEditor
          entries={draft.env}
          onChange={(env) => onChange({ env })}
          scopeLabel={t("providerAccounts.account.envScope", { name: draft.name })}
        />
      </div>
    </div>
  );
}
