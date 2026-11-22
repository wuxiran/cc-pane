// 供应商账号的界面侧共用规则：哪些账号能在某个 CLI 下选、默认是哪个、颜色怎么画。
//
// 启动器、运行配置、工作空间、供应商编辑页、标签标记都用这里，保证「这个 CLI 下有几个账号」
// 在各处算出来是同一个数。
import { WORKSPACE_COLORS, type WorkspaceColor } from "@/types/workspace";
import {
  DEFAULT_LOGIN_ACCOUNT_ID,
  type LoginAccountCliTool,
  type Provider,
  type ProviderAccount,
  type ProviderType,
} from "@/types/provider";

/** 每类供应商下能挂哪些 CLI 的登录账号（镜像后端 `Provider::login_cli_tools`）。 */
const LOGIN_CLI_TOOLS: Record<ProviderType, readonly LoginAccountCliTool[]> = {
  anthropic: ["claude"],
  bedrock: ["claude"],
  vertex: ["claude"],
  proxy: ["claude"],
  open_ai: ["codex"],
  gemini: ["gemini", "antigravity"],
  grok: ["grok"],
  config_profile: [],
  kimi: [],
  opencode: [],
  cursor: [],
};

export function loginCliToolsForProviderType(type: ProviderType): readonly LoginAccountCliTool[] {
  return LOGIN_CLI_TOOLS[type] ?? [];
}

/** 账号颜色：与工作空间颜色同一套 `--app-tag-*` token，存的是名字（如 `blue`）。 */
export const ACCOUNT_COLORS = WORKSPACE_COLORS;
export type AccountColor = WorkspaceColor;

export function isAccountColor(value: string | null | undefined): value is AccountColor {
  return !!value && (ACCOUNT_COLORS as readonly string[]).includes(value);
}

/** 颜色名 → CSS 变量；不认识的颜色（外部导入的任意值）不画。 */
export function accountColorVar(color: string | null | undefined): string | undefined {
  return isAccountColor(color) ? `var(--app-tag-${color})` : undefined;
}

/** 启动器 / 运行配置 / 工作空间里可选的一项账号。 */
export interface SelectableAccount {
  id: string;
  /** 合成的默认登录没有落盘名字，界面用 i18n 文案显示（见 `isDefaultLogin`）。 */
  name: string;
  color?: string | null;
  kind: "api_key" | "login";
  cliTool?: LoginAccountCliTool | null;
  /** 供应商的默认账号（没点名账号时启动用它）。 */
  isDefault: boolean;
  /** 合成的「默认登录」（机器上原有的那套登录）。 */
  isDefaultLogin: boolean;
}

/** 供应商的默认账号 id（`defaultAccountId` 失效时退回第一个）。 */
export function defaultAccountId(provider: Provider): string | undefined {
  const accounts = provider.accounts ?? [];
  return (accounts.find((account) => account.id === provider.defaultAccountId) ?? accounts[0])?.id;
}

function usableFor(account: ProviderAccount, cliTool: string | null | undefined): boolean {
  if (account.kind !== "login") return true;
  return !cliTool || account.cliTool === cliTool;
}

/**
 * 这条供应商在某个 CLI 下能选的账号。
 *
 * - 密钥账号总能选；登录账号只在它所属的 CLI 下能选。
 * - 「默认登录」只在这个 CLI 下已经建过登录账号时才列出：普通密钥供应商只有一个默认密钥
 *   账号，不该因为合成的默认登录多出一步选择。
 * - `cliTool` 缺省 = 不按 CLI 过滤（工作空间绑定这类不限 CLI 的入口）。
 */
export function selectableAccounts(
  provider: Provider | null | undefined,
  cliTool?: string | null,
): SelectableAccount[] {
  if (!provider) return [];
  const fallbackDefault = defaultAccountId(provider);
  const accounts = (provider.accounts ?? []).filter((account) => usableFor(account, cliTool));
  const result: SelectableAccount[] = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    color: account.color,
    kind: account.kind,
    cliTool: account.cliTool,
    isDefault: account.id === fallbackDefault,
    isDefaultLogin: false,
  }));
  const loginTools = loginCliToolsForProviderType(provider.providerType);
  const defaultLoginTool = cliTool
    ? loginTools.find((tool) => tool === cliTool)
    : loginTools.find((tool) => accounts.some((account) => account.kind === "login" && account.cliTool === tool));
  const hasLoginAccount = accounts.some(
    (account) => account.kind === "login" && (!defaultLoginTool || account.cliTool === defaultLoginTool),
  );
  if (defaultLoginTool && hasLoginAccount) {
    result.push({
      id: DEFAULT_LOGIN_ACCOUNT_ID,
      name: "",
      kind: "login",
      cliTool: defaultLoginTool,
      isDefault: false,
      isDefaultLogin: true,
    });
  }
  return result;
}

/** 选中的账号还在不在可选列表里（账号被删 / 换了 CLI 时，记忆的选择要作废）。 */
export function isSelectableAccount(
  provider: Provider | null | undefined,
  cliTool: string | null | undefined,
  accountId: string | null | undefined,
): boolean {
  if (!accountId) return false;
  return selectableAccounts(provider, cliTool).some((account) => account.id === accountId);
}

/** 按 id 找账号的显示信息（标签标记、摘要卡用）。默认登录没有落盘记录，返回 undefined。 */
export function findProviderAccount(
  provider: Provider | null | undefined,
  accountId: string | null | undefined,
): ProviderAccount | undefined {
  if (!provider || !accountId) return undefined;
  return (provider.accounts ?? []).find((account) => account.id === accountId);
}
