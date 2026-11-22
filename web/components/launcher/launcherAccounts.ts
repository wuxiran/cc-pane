// 启动器 / 运行配置 / 工作空间 / 标签共用的账号显示与校验小工具（纯逻辑，无 React）。
// 「哪些账号能选」一律走 @/utils/providerAccounts 的 selectableAccounts，这里只叠两条界面规则：
// 远端运行时禁用本机登录账号、失效的选择退回默认账号。
import type { Provider } from "@/types";
import { isDefaultLoginAccount } from "@/types/provider";
import { selectableAccounts, type SelectableAccount } from "@/utils/providerAccounts";

/**
 * 登录账号对应本机目录，WSL / SSH 那一侧用不了（后端 `PROVIDER_LOGIN_ACCOUNT_LOCAL_ONLY`）。
 * 合成的「默认登录」没有本机目录，远端照常可用；密钥账号也不受影响。
 */
export function isLocalOnlyAccount(account: Pick<SelectableAccount, "kind" | "isDefaultLogin">): boolean {
  return account.kind === "login" && !account.isDefaultLogin;
}

/**
 * 启动时真正带上的账号 id：选中的账号在这个 CLI 下已不可选（被删 / 换了 CLI）、或运行时是远端而它是
 * 本机登录账号时，退回 undefined（= 供应商默认账号）。
 */
export function effectiveLaunchAccountId(
  provider: Provider | null | undefined,
  cliTool: string | null | undefined,
  accountId: string | null | undefined,
  remote = false,
): string | undefined {
  const id = accountId?.trim();
  if (!id) return undefined;
  const account = selectableAccounts(provider, cliTool).find((item) => item.id === id);
  if (!account) return undefined;
  if (remote && isLocalOnlyAccount(account)) return undefined;
  return id;
}

/**
 * 运行配置保存用：只有多账号时才记账号；单账号 / 未选 / 失效时显式给 null（字段不能丢，
 * 不带会被后端清空，带 null 表示「用供应商默认账号」）。选中的就是默认账号时也记 null，
 * 以后默认账号换了跟着走。
 */
export function profileAccountIdForSave(
  provider: Provider | null | undefined,
  cliTool: string | null | undefined,
  accountId: string | null | undefined,
): string | null {
  const accounts = selectableAccounts(provider, cliTool);
  if (accounts.length <= 1) return null;
  const account = accounts.find((item) => item.id === accountId);
  if (!account || account.isDefault) return null;
  return account.id;
}

/** 账号显示名：默认登录没有落盘名字，用调用方给的 i18n 文案；名字为空时退回 id。 */
export function accountDisplayName(
  account: { id: string; name?: string | null },
  defaultLoginLabel: string,
): string {
  if (isDefaultLoginAccount(account.id)) return defaultLoginLabel;
  return account.name?.trim() || account.id;
}
