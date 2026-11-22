// 账号与自定义环境变量在编辑表单里的草稿形态，以及草稿 → 保存载荷的换算。
//
// 写入约定（后端 `normalize_accounts`）：
// - 密钥：`secret` 非空 = 替换；留空且 `secretStorage` 非 none = 保持；`secretStorage` 清成 none = 清除。
// - 敏感环境变量：读到的值为空；留空且 `storage` 非 none = 保持（按**名字**找旧值），
//   所以改名或取消敏感后必须重填值，否则旧值会丢。
import type {
  LoginAccountCliTool,
  Provider,
  ProviderAccount,
  ProviderEnvVar,
  SecretStorage,
} from "@/types/provider";

export interface EnvDraft {
  /** 只给 React 当 key，不落盘。 */
  key: string;
  name: string;
  value: string;
  sensitive: boolean;
  storage: SecretStorage;
  /** 读进来时的名字与敏感标记；新增的条目为 null。 */
  originalName: string | null;
  originalSensitive: boolean;
}

export interface AccountDraft {
  id: string;
  name: string;
  color: string | null;
  kind: "api_key" | "login";
  secretStorage: SecretStorage;
  /** 新密钥（仅写入）；空 = 不换。 */
  secret: string;
  cliTool: LoginAccountCliTool | null;
  configDir: string | null;
  env: EnvDraft[];
  /** 还没保存过（只在表单里）：删除时不用找后端。 */
  isNew: boolean;
}

let envKeySeq = 0;
function nextEnvKey(): string {
  envKeySeq += 1;
  return `env-${envKeySeq}`;
}

export function envDraftsFrom(entries: ProviderEnvVar[] | undefined, keepStorage = true): EnvDraft[] {
  return (entries ?? []).map((entry) => ({
    key: nextEnvKey(),
    name: entry.name,
    value: entry.sensitive ? "" : entry.value ?? "",
    sensitive: !!entry.sensitive,
    storage: keepStorage && entry.sensitive ? entry.storage ?? "none" : "none",
    originalName: keepStorage ? entry.name : null,
    originalSensitive: !!entry.sensitive,
  }));
}

export function newEnvDraft(): EnvDraft {
  return {
    key: nextEnvKey(),
    name: "",
    value: "",
    sensitive: false,
    storage: "none",
    originalName: null,
    originalSensitive: false,
  };
}

/** 已存的敏感值是否还能保持：存过、没填新值、名字没改、仍是敏感。 */
export function envKeepsStoredValue(entry: EnvDraft): boolean {
  return entry.storage !== "none" && entry.value === "" && entry.sensitive
    && entry.name.trim() === entry.originalName;
}

/** 存过敏感值、但改了名或取消了敏感、又没填新值：保存会丢掉旧值，要求重填。 */
export function envNeedsRefill(entry: EnvDraft): boolean {
  return entry.storage !== "none" && entry.value === "" && !envKeepsStoredValue(entry);
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvProblem = "name_invalid" | "name_duplicate" | "needs_refill" | "value_required";

/** 第一处问题（给 toast 用）；没问题返回 null。 */
export function envProblem(entries: EnvDraft[]): { problem: EnvProblem; name: string } | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!ENV_NAME_RE.test(name) || name.length > 256) return { problem: "name_invalid", name };
    if (seen.has(name)) return { problem: "name_duplicate", name };
    seen.add(name);
    if (envNeedsRefill(entry)) return { problem: "needs_refill", name };
    if (entry.sensitive && entry.value === "" && !envKeepsStoredValue(entry)) {
      return { problem: "value_required", name };
    }
  }
  return null;
}

export function envPayload(entries: EnvDraft[]): ProviderEnvVar[] {
  return entries.map((entry) => {
    const name = entry.name.trim();
    if (!entry.sensitive) return { name, value: entry.value, sensitive: false, storage: "none" };
    return {
      name,
      value: entry.value === "" ? null : entry.value,
      sensitive: true,
      storage: entry.value === "" ? entry.storage : "none",
    };
  });
}

export function accountDraftsFrom(provider: Provider | null | undefined): AccountDraft[] {
  return (provider?.accounts ?? []).map((account) => ({
    id: account.id,
    name: account.name,
    color: account.color ?? null,
    kind: account.kind,
    secretStorage: account.kind === "api_key" ? account.secretStorage ?? "none" : "none",
    secret: "",
    cliTool: account.cliTool ?? null,
    configDir: account.configDir ?? null,
    env: envDraftsFrom(account.env),
    isNew: false,
  }));
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 新密钥账号：id 由前端生成（后端字符集：字母数字与 - _ . :）。 */
export function newKeyAccountDraft(name: string, color: string | null): AccountDraft {
  return {
    id: `key-${randomHex(6)}`,
    name,
    color,
    kind: "api_key",
    secretStorage: "none",
    secret: "",
    cliTool: null,
    configDir: null,
    env: [],
    isNew: true,
  };
}

export function accountPayload(draft: AccountDraft): ProviderAccount {
  const base = {
    id: draft.id,
    name: draft.name.trim(),
    color: draft.color,
    env: envPayload(draft.env),
  };
  if (draft.kind === "login") {
    return { ...base, kind: "login", cliTool: draft.cliTool, configDir: draft.configDir };
  }
  return {
    ...base,
    kind: "api_key",
    secretStorage: draft.secret ? "none" : draft.secretStorage,
    secret: draft.secret || null,
  };
}

export type AccountProblem = "name_required" | "name_duplicate";

export function accountProblem(drafts: AccountDraft[]): { problem: AccountProblem; name: string } | null {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) return { problem: "name_required", name };
    const folded = name.toLowerCase();
    if (seen.has(folded)) return { problem: "name_duplicate", name };
    seen.add(folded);
  }
  return null;
}

/** 密钥账号的显示状态：待保存的新密钥优先。 */
export type SecretDisplay = "pending" | "keychain" | "file" | "none";

export function secretDisplay(draft: Pick<AccountDraft, "secret" | "secretStorage">): SecretDisplay {
  if (draft.secret) return "pending";
  return draft.secretStorage;
}

/** 已在后端生效的账号变化（建登录账号 / 删账号）套到表单状态上；删的是默认账号时退回第一个（同后端）。 */
export function applyPersistedAccountChange<T extends { accounts: AccountDraft[]; defaultAccountId: string | null }>(
  state: T,
  change: { type: "added"; account: AccountDraft } | { type: "removed"; accountId: string },
): T {
  if (change.type === "added") {
    if (state.accounts.some((account) => account.id === change.account.id)) return state;
    return { ...state, accounts: [...state.accounts, change.account] };
  }
  const accounts = state.accounts.filter((account) => account.id !== change.accountId);
  const defaultAccountId = state.defaultAccountId === change.accountId ? accounts[0]?.id ?? null : state.defaultAccountId;
  return { ...state, accounts, defaultAccountId };
}
