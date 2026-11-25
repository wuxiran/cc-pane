// 运行配置的「凭证」：把「供应商 → 账号」两级拍平成三类，用户只需回答「用什么登录」。
//
// - cli：不注入供应商，CLI 用它自己的登录 / 配置（providerId = null）
// - oauth：某个供应商下的登录账号（CLI 自己的 OAuth 登录，各用独立目录）
// - relay：中转站 / 密钥（供应商的接口地址 + 密钥账号）
//
// 只是界面上的分类，存储结构不变：仍写 providerId + providerAccountId（null = 供应商默认账号）。
import type { Provider } from "@/types";
import { defaultAccountId, selectableAccounts } from "@/utils/providerAccounts";
import { accountDisplayName, isLocalOnlyAccount } from "@/components/launcher/launcherAccounts";

export type CredentialKind = "cli" | "oauth" | "relay";

export interface CredentialOption {
  key: string;
  kind: Exclude<CredentialKind, "cli">;
  providerId: string;
  /** 保存用：是供应商默认账号时写 null。 */
  accountId: string | null;
  /** 实际生效的账号 id（用来跟草稿对上）。 */
  effectiveAccountId: string | null;
  label: string;
  color?: string | null;
  /** 本机登录账号：WSL / SSH 启动时会退回供应商默认账号。 */
  localOnly: boolean;
}

export function credentialKey(providerId: string, effectiveAccountId: string | null): string {
  return `${providerId}::${effectiveAccountId ?? ""}`;
}

export function credentialOptions(
  providers: readonly Provider[],
  cliTool: string,
  defaultLoginLabel: string,
): { oauth: CredentialOption[]; relay: CredentialOption[] } {
  const oauth: CredentialOption[] = [];
  const relay: CredentialOption[] = [];
  for (const provider of providers) {
    const accounts = selectableAccounts(provider, cliTool);
    if (accounts.length === 0) {
      relay.push({
        key: credentialKey(provider.id, null),
        kind: "relay",
        providerId: provider.id,
        accountId: null,
        effectiveAccountId: null,
        label: provider.name,
        localOnly: false,
      });
      continue;
    }
    const keyAccounts = accounts.filter((account) => account.kind !== "login");
    for (const account of accounts) {
      const isLogin = account.kind === "login";
      const name = accountDisplayName(account, defaultLoginLabel);
      const label = isLogin || keyAccounts.length > 1 ? `${provider.name} · ${name}` : provider.name;
      const option: CredentialOption = {
        key: credentialKey(provider.id, account.id),
        kind: isLogin ? "oauth" : "relay",
        providerId: provider.id,
        accountId: account.isDefault ? null : account.id,
        effectiveAccountId: account.id,
        label,
        color: account.color,
        localOnly: isLocalOnlyAccount(account),
      };
      (isLogin ? oauth : relay).push(option);
    }
  }
  return { oauth, relay };
}

/** 草稿当前选中的凭证项；没选供应商返回 null（= cli）。供应商不在列表里时也返回 null，由调用方兜底显示。 */
export function selectedCredential(
  options: { oauth: CredentialOption[]; relay: CredentialOption[] },
  providers: readonly Provider[],
  providerId: string | null | undefined,
  providerAccountId: string | null | undefined,
): CredentialOption | null {
  if (!providerId) return null;
  const provider = providers.find((item) => item.id === providerId);
  const effective = providerAccountId ?? (provider ? defaultAccountId(provider) ?? null : null);
  const key = credentialKey(providerId, effective);
  return [...options.oauth, ...options.relay].find((option) => option.key === key)
    // 账号已失效：退回这家供应商的任一项（启动时后端同样退回默认账号）
    ?? [...options.relay, ...options.oauth].find((option) => option.providerId === providerId)
    ?? null;
}
