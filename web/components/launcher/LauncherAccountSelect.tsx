// 供应商下的账号选择（启动器、工作空间默认账号共用）：只有一个可选账号时不渲染（设计稿「只有一个账号时
// 不显示第二步」）。值为 undefined = 用供应商默认账号；选回默认账号也写 undefined。
import { useTranslation } from "react-i18next";
import AccountColorDot from "@/components/providers/accounts/AccountColorDot";
import type { Provider } from "@/types";
import { defaultAccountId, selectableAccounts } from "@/utils/providerAccounts";
import { accountDisplayName, isLocalOnlyAccount } from "./launcherAccounts";

interface LauncherAccountSelectProps {
  provider: Provider | null | undefined;
  /** 按 CLI 过滤登录账号；缺省 = 不过滤（工作空间绑定这类不限 CLI 的入口）。 */
  cliTool?: string | null;
  value: string | null | undefined;
  onChange: (accountId: string | undefined) => void;
  /** 运行时是 WSL / SSH：本机登录账号禁用并说明。 */
  remote?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export default function LauncherAccountSelect({
  provider, cliTool, value, onChange, remote = false, disabled, ariaLabel, className = "",
}: LauncherAccountSelectProps) {
  const { t } = useTranslation("launcher");
  const accounts = selectableAccounts(provider, cliTool);
  if (!provider || accounts.length <= 1) return null;

  const fallbackId = defaultAccountId(provider);
  const selectedId = accounts.some((account) => account.id === value) ? value! : fallbackId ?? "";
  const selected = accounts.find((account) => account.id === selectedId);
  const defaultLoginLabel = t("account.defaultLogin");
  const anyLocalOnlyDisabled = remote && accounts.some(isLocalOnlyAccount);
  const optionLabel = (account: (typeof accounts)[number]) => {
    const name = accountDisplayName(account, defaultLoginLabel);
    if (remote && isLocalOnlyAccount(account)) return t("account.loginLocalOnlyOption", { name });
    return account.isDefault ? t("account.defaultSuffix", { name }) : name;
  };

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-center gap-1.5">
        <AccountColorDot color={selected?.color} title={selected ? accountDisplayName(selected, defaultLoginLabel) : undefined} />
        <select
          className="h-8 min-w-[140px] rounded-md border bg-background px-2 text-xs"
          value={selectedId}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            onChange(!next || next === fallbackId ? undefined : next);
          }}
          aria-label={ariaLabel ?? t("account.label")}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={remote && isLocalOnlyAccount(account)}>
              {optionLabel(account)}
            </option>
          ))}
        </select>
      </div>
      {anyLocalOnlyDisabled && (
        <span className="text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t("account.loginLocalOnly")}</span>
      )}
    </div>
  );
}
