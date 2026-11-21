import type { KnownCliTool, LaunchEffort } from "./terminal";

export type ProviderType =
  | "anthropic"
  | "bedrock"
  | "vertex"
  | "proxy"
  | "config_profile"
  | "open_ai"
  | "gemini"
  | "kimi"
  | "opencode"
  | "cursor"
  | "grok";

export interface ProviderModel {
  id: string;
  label?: string | null;
  defaultEffort?: LaunchEffort | null;
  /** 已 token 数字形式存的窗口（用于显示 / context 解析）。 */
  contextWindowTokens?: number | null;
  /**
   * 上下文窗口大小，**字符串形式**，匹配 Claude Code 的 `ANTHROPIC_MODEL` 后缀约定
   * （`[1m]` / `[200k]` / `[500k]` 等）。managed_settings 注入 `--settings` 时按此值
   * 拼 `[<size>]` 后缀到 model id。空 / `"200k"`（默认）不拼，`"custom"` 表示用户自行管 env。
   * 与 `contextWindowTokens` 互补：前者控制注入时形态，后者控制 context 解析。
   */
  contextSize?: string | null;
}

export const MIN_PROVIDER_CONTEXT_WINDOW_TOKENS = 1_000;
export const MAX_PROVIDER_CONTEXT_WINDOW_TOKENS = 10_000_000;

export function isValidProviderContextWindowTokens(
  value: number | null | undefined,
): boolean {
  return value === null || value === undefined || (
    Number.isInteger(value)
    && value >= MIN_PROVIDER_CONTEXT_WINDOW_TOKENS
    && value <= MAX_PROVIDER_CONTEXT_WINDOW_TOKENS
  );
}

/** `contextSize` 字符串反解为 token 数字。空 / "custom" / 不可解析 → 0 表示「未知」。 */
export function contextSizeToTokens(size: string | null | undefined): number {
  const s = (size ?? "").trim().toLowerCase();
  if (s === "" || s === "custom") return 0;
  if (s.endsWith("m")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
  }
  if (s.endsWith("k")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n * 1_000) : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * 把 model id 拼上 `[<size>]` 后缀，匹配 Claude Code 的 ANTHROPIC_MODEL 约定。
 * 空 / "200k" / "custom" / 已带相同后缀 → 不变。
 */
export function applyContextSizeSuffix(model: string, contextSize: string | null | undefined): string {
  const cs = (contextSize ?? "").trim();
  if (cs === "" || cs.toLowerCase() === "200k" || cs.toLowerCase() === "custom") {
    return model;
  }
  const suffix = `[${cs}]`;
  if (model.includes(suffix)) return model;
  return `${model}${suffix}`;
}

/** 从带 `[...]` 后缀的 model 字符串反解 token 数。无后缀 / 不可解析 → 0。 */
export function parseContextWindowFromModel(model: string): number {
  const start = model.lastIndexOf("[");
  if (start < 0) return 0;
  const end = model.indexOf("]", start);
  if (end < 0) return 0;
  return contextSizeToTokens(model.slice(start + 1, end));
}

/** 密钥 / 敏感值存在哪：`keychain` = 系统钥匙串；`file` = 当前环境没有钥匙串，仍在 providers.json（未进钥匙串）。 */
export type SecretStorage = "none" | "keychain" | "file";

/** 一条自定义环境变量。敏感条目的值不回传：读到的 `value` 为空，只看 `storage`。 */
export interface ProviderEnvVar {
  name: string;
  /** 非敏感：明文值。敏感：仅在写入时填新值；留空且 `storage` 非 none 表示保持原值。 */
  value?: string | null;
  sensitive?: boolean;
  storage?: SecretStorage;
}

export type ProviderEndpointKind = "anthropic" | "chat" | "responses" | "gemini";

/** 一条供应商的多个接口地址。哪种 CLI 用哪种接口，就取哪个地址。 */
export type ProviderEndpoints = Partial<Record<ProviderEndpointKind, string | null>>;

/** 支持登录账号的 CLI，以及各自指目录的环境变量（镜像后端 `login_dir_env_var`）。 */
export const LOGIN_ACCOUNT_DIR_ENV = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  gemini: "GEMINI_CLI_HOME",
  antigravity: "GEMINI_HOME",
  grok: "GROK_HOME",
} as const;

export type LoginAccountCliTool = keyof typeof LOGIN_ACCOUNT_DIR_ENV;

/** 供应商下的账号：一把密钥（`api_key`），或一套 CLI 自己的登录（`login`，对应一个独立目录）。 */
export interface ProviderAccount {
  id: string;
  name: string;
  color?: string | null;
  kind: "api_key" | "login";
  /** 密钥账号：密钥存在哪。`none` / 缺省 = 没有密钥。 */
  secretStorage?: SecretStorage;
  /** 仅写入：新密钥明文。读到的永远为空；留空且 `secretStorage` 非 none 表示保持原密钥。 */
  secret?: string | null;
  /** 登录账号：属于哪个 CLI。 */
  cliTool?: LoginAccountCliTool | null;
  /** 登录账号：对应的目录。 */
  configDir?: string | null;
  env?: ProviderEnvVar[];
}

/**
 * 合成「默认登录」账号的固定 id（镜像后端 `DEFAULT_LOGIN_ACCOUNT_ID`）。
 * 它代表机器上原有的那套登录（CLI 的默认目录）：不建目录、不带目录变量、**不落盘**，
 * 只出现在 `listLoginAccounts` 的结果里；把它当作账号 id 传给启动请求即可使用。
 */
export const DEFAULT_LOGIN_ACCOUNT_ID = "__default_login__";

export function isDefaultLoginAccount(id: string | null | undefined): boolean {
  return id === DEFAULT_LOGIN_ACCOUNT_ID;
}

/** 登录状态。`unknown` = 读不出来（不猜）。 */
export type LoginState = "logged_in" | "not_logged_in" | "unknown";

export interface LoginAccountStatus {
  state: LoginState;
  /** 邮箱或账号名；读不到时没有。 */
  identity?: string;
  /** 凭据在哪找到的。 */
  credentialSource?: "file" | "keychain";
  /** 凭据过期时间（RFC 3339），只有 CLI 在账号信息里写了才有。 */
  expiresAt?: string;
  /** `unknown` 的原因码：keychain_unavailable / antigravity_reports_in_cli / credential_file_missing / account_file_unreadable / home_unavailable / unsupported_cli。 */
  reason?: string;
}

/** 一个登录账号（`list_login_accounts` / `create_login_account`）。 */
export interface LoginAccountView {
  providerId: string;
  accountId: string;
  name: string;
  color?: string;
  cliTool: LoginAccountCliTool;
  /** 合成的默认登录：不能删除，没有目录。 */
  isDefaultLogin: boolean;
  /** 账号目录；默认登录没有。 */
  configDir?: string;
  /** 目录是 CC-Panes 自己建的：只有这种目录可以随账号一起删。 */
  dirManaged: boolean;
  dirExists: boolean;
  status: LoginAccountStatus;
}

export interface CreateLoginAccountRequest {
  cliTool: LoginAccountCliTool;
  name: string;
  color?: string | null;
}

/** 要在终端里执行的登录命令（`get_login_account_command`）。 */
export interface LoginCommand {
  cliTool: LoginAccountCliTool;
  command: string;
  args: string[];
  /** 要加的环境变量（目录变量等）。 */
  env: Record<string, string>;
  /** 要从继承环境里去掉的变量。 */
  envRemove: string[];
  /** 这个 CLI 没有单独的登录命令：启动的是 CLI 本身，用户要在里面选登录方式（Gemini CLI）。 */
  interactive: boolean;
  /** `command` 是否已解析成本机上的可执行文件；`false` = 没找到，返回的是裸名字。 */
  executableFound: boolean;
}

/** 删除账号的结果（`delete_provider_account`）。 */
export interface DeleteAccountOutcome {
  accountId: string;
  configDir?: string;
  dirDeleted: boolean;
  /** 要求删目录却没删时的原因码：external_dir / dir_missing / remove_failed。 */
  dirKeptReason?: "external_dir" | "dir_missing" | "remove_failed";
}

export interface ProviderOrigin {
  kind: "manual" | "cc_switch" | "magpie" | "local_gateway";
  externalId?: string | null;
  importedAt?: string | null;
  fingerprint?: string | null;
}

export interface Provider {
  id: string;
  name: string;
  providerType: ProviderType;
  /**
   * 兼容写入：默认账号的密钥。**读到的永远为空**（密钥不出后端）。
   * 写入时 `null` / 缺省 = 不动，非空 = 换成新密钥。是否已有密钥看 {@link providerHasSecret}。
   */
  apiKey?: string | null;
  /** 兼容视图：主接口地址（`endpoints` 里该类型对应那一项）的镜像；写入时同样落到主接口。 */
  baseUrl?: string | null;
  region?: string | null;
  projectId?: string | null;
  awsProfile?: string | null;
  /** 兼容视图：默认账号是登录账号时它的目录。 */
  configDir?: string | null;
  codexWireApi?: string | null;
  models?: ProviderModel[];
  defaultModelId?: string | null;
  isDefault: boolean;
  /** 以下为账号化之后的字段。旧界面不带它们保存时，后端整组沿用已存的值。 */
  endpoints?: ProviderEndpoints;
  env?: ProviderEnvVar[];
  accounts?: ProviderAccount[];
  defaultAccountId?: string | null;
  source?: ProviderOrigin | null;
}

/** 供应商的默认账号（`defaultAccountId` 失效时退回第一个）。 */
export function providerDefaultAccount(provider: Provider): ProviderAccount | undefined {
  const accounts = provider.accounts ?? [];
  return accounts.find((account) => account.id === provider.defaultAccountId) ?? accounts[0];
}

/** 默认账号是否已存有密钥（密钥本身读不到，只能看标记）。 */
export function providerHasSecret(provider: Provider): boolean {
  const account = providerDefaultAccount(provider);
  return account?.kind === "api_key" && !!account.secretStorage && account.secretStorage !== "none";
}

/** 注入预览的一行（`preview_provider_env`）。敏感值已打码。 */
export interface ProviderEnvPreviewEntry {
  name: string;
  value: string;
  sensitive: boolean;
  layer: "generated" | "provider" | "account";
  /** 用户填的值盖掉了自动生成的同名变量。 */
  overridesGenerated: boolean;
}

/** 测试连接 / 拉模型列表 / 一次性补全用的凭据（`resolve_provider_api_credentials`）。只在内存里用。 */
export interface ProviderApiCredentials {
  apiKey?: string | null;
  baseUrl?: string | null;
  endpoints?: ProviderEndpoints;
}

/**
 * 合成「系统环境变量」provider 的固定 id（镜像后端 `SYSTEM_PROVIDER_ID`）。
 * 选中它表示不注入任何 provider 环境变量，跟随宿主/cc-switch 当前配置。**不落盘**。
 */
export const SYSTEM_PROVIDER_ID = "__system__";

export function isSystemProvider(id: string | null | undefined): boolean {
  return id === SYSTEM_PROVIDER_ID;
}

/**
 * 构造用于列表展示的合成「系统环境变量」条目。
 * `providerType` 仅为满足类型占位（渲染/启动均按 id 特判，不会读取它）。
 */
export function createSystemProvider(name: string, isDefault = false): Provider {
  return {
    id: SYSTEM_PROVIDER_ID,
    name,
    providerType: "config_profile",
    isDefault,
  };
}

/**
 * 「系统环境变量」条目的探测结果（镜像后端 `SystemProviderInfo`）。
 * `envKeys` 只含命中的**变量名**，不含值。
 */
export interface SystemProviderInfo {
  /** 探测到 cc-switch 或宿主 Anthropic 凭证之一 */
  active: boolean;
  /** 探测到 `~/.cc-switch/cc-switch.db` */
  ccSwitch: boolean;
  /** 宿主进程中命中的 Anthropic 环境变量名 */
  envKeys: string[];
  /** 用户已把「系统环境变量」设为默认凭证（持久化状态） */
  defaultIsSystem: boolean;
  /** 每个 CLI 工具对应的持久化默认 Provider id */
  defaultProviderIds: Partial<Record<KnownCliTool, string>>;
}

export type ProviderTypeLabelKey =
  | "providerTypeAnthropicLabel"
  | "providerTypeBedrockLabel"
  | "providerTypeVertexLabel"
  | "providerTypeProxyLabel"
  | "providerTypeConfigLabel"
  | "providerTypeOpenAILabel"
  | "providerTypeGeminiLabel"
  | "providerTypeKimiLabel"
  | "providerTypeOpenCodeLabel"
  | "providerTypeCursorLabel"
  | "providerTypeGrokLabel";

export type ProviderTypeDescKey =
  | "providerTypeAnthropicDesc"
  | "providerTypeBedrockDesc"
  | "providerTypeVertexDesc"
  | "providerTypeProxyDesc"
  | "providerTypeConfigDesc"
  | "providerTypeOpenAIDesc"
  | "providerTypeGeminiDesc"
  | "providerTypeKimiDesc"
  | "providerTypeOpenCodeDesc"
  | "providerTypeCursorDesc"
  | "providerTypeGrokDesc";

export const PROVIDER_TYPE_META: Record<
  ProviderType,
  { labelKey: ProviderTypeLabelKey; descriptionKey: ProviderTypeDescKey; fields: string[] }
> = {
  anthropic: {
    labelKey: "providerTypeAnthropicLabel",
    descriptionKey: "providerTypeAnthropicDesc",
    fields: ["apiKey", "baseUrl"],
  },
  bedrock: {
    labelKey: "providerTypeBedrockLabel",
    descriptionKey: "providerTypeBedrockDesc",
    fields: ["region", "awsProfile"],
  },
  vertex: {
    labelKey: "providerTypeVertexLabel",
    descriptionKey: "providerTypeVertexDesc",
    fields: ["region", "projectId"],
  },
  proxy: {
    labelKey: "providerTypeProxyLabel",
    descriptionKey: "providerTypeProxyDesc",
    fields: ["apiKey", "baseUrl"],
  },
  config_profile: {
    labelKey: "providerTypeConfigLabel",
    descriptionKey: "providerTypeConfigDesc",
    fields: ["configDir"],
  },
  open_ai: {
    labelKey: "providerTypeOpenAILabel",
    descriptionKey: "providerTypeOpenAIDesc",
    fields: ["apiKey", "baseUrl"],
  },
  gemini: {
    labelKey: "providerTypeGeminiLabel",
    descriptionKey: "providerTypeGeminiDesc",
    fields: ["apiKey", "baseUrl"],
  },
  kimi: {
    labelKey: "providerTypeKimiLabel",
    descriptionKey: "providerTypeKimiDesc",
    fields: ["apiKey", "baseUrl"],
  },
  opencode: {
    labelKey: "providerTypeOpenCodeLabel",
    descriptionKey: "providerTypeOpenCodeDesc",
    fields: ["apiKey", "baseUrl"],
  },
  cursor: {
    labelKey: "providerTypeCursorLabel",
    descriptionKey: "providerTypeCursorDesc",
    fields: ["apiKey"],
  },
  grok: {
    labelKey: "providerTypeGrokLabel",
    descriptionKey: "providerTypeGrokDesc",
    fields: ["apiKey", "baseUrl"],
  },
};

/** CLI Tool Tab 定义 */
export const CLI_TOOL_TABS = [
  { id: "claude" as const, labelKey: "tabClaude", accentColor: "#E8590C" },
  { id: "codex" as const, labelKey: "tabCodex", accentColor: "#10A37F" },
  { id: "pi" as const, labelKey: "tabPi", accentColor: "#F59E0B" },
  { id: "omp" as const, labelKey: "tabOmp", accentColor: "#EC4899" },
  { id: "gemini" as const, labelKey: "tabGemini", accentColor: "#4285F4" },
  { id: "kimi" as const, labelKey: "tabKimi", accentColor: "#F97316" },
  { id: "opencode" as const, labelKey: "tabOpenCode", accentColor: "#8B5CF6" },
  { id: "cursor" as const, labelKey: "tabCursor", accentColor: "#111827" },
  { id: "grok" as const, labelKey: "tabGrok", accentColor: "#71767B" },
  { id: "jcode" as const, labelKey: "tabJcode", accentColor: "#0891B2" },
  { id: "antigravity" as const, labelKey: "tabAntigravity", accentColor: "#4F46E5" },
] as const;

export type PresetCategory = "official" | "cloud" | "proxy_intl" | "openai_compat" | "domestic";

export interface ProviderPreset {
  id: string;
  nameKey: string;
  descKey: string;
  category: PresetCategory;
  providerType: ProviderType;
  defaults: Partial<Pick<Provider, "baseUrl" | "region" | "projectId" | "awsProfile">>;
  userFields: string[];
  website?: string;
  accentColor?: string;
  order: number;
  /** Override which CLI tool tab(s) this preset belongs to (e.g. for proxy presets) */
  compatibleCliTools?: KnownCliTool[];
}

export interface ConfigDirInfo {
  path: string;
  hasSettings: boolean;
  hasCredentials: boolean;
  settingsSummary: string | null;
  files: string[];
}
