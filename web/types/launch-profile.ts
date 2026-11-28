import type { NativeOverrides } from "./native-config";
import i18n from "@/i18n";
import type { Provider } from "./provider";
import type { SkillDeliveryMode } from "./skill";
import type { LaunchEffort, PiLaunchOptions } from "./terminal";
import type { WorkspaceLaunchEnvironment } from "./workspace";

export type LaunchProfileMcpMode = "default" | "custom" | "disabled";
/** 共享 MCP 的投递方式（docs/113），与 mode 正交：mode 管「给哪些」，delivery 管「怎么给」。 */
export type McpDelivery = "direct" | "hub";
export type LaunchProfileSkillMode = "core" | "custom" | "disabled";
export type LaunchProviderSelection = "inherit" | "explicit" | "none";
export type LaunchProfileRuntime = WorkspaceLaunchEnvironment | null;
export type KimiConfigMode = "managed" | "native";

export interface LaunchProfileAdapterOptions extends PiLaunchOptions {
  kimiConfigMode?: KimiConfigMode;
  effort?: LaunchEffort;
  [key: string]: unknown;
}

export interface LaunchProfileMcpPolicy {
  mode: LaunchProfileMcpMode;
  enabledServerIds: string[];
  disabledServerIds: string[];
  includeCcpanesMcp: boolean;
  includeSharedMcp: boolean;
  /** 不支持 hub 的组合（WSL / SSH / 其余 CLI / sse 服务器）自动回退直连，见 `hubDeliverySupported`。 */
  delivery: McpDelivery;
}

export interface LaunchProfileSkillPolicy {
  mode: LaunchProfileSkillMode;
  enabledSkillIds: string[];
  disabledSkillIds: string[];
  profileSkills: LaunchProfileSkill[];
  includeProjectSkills: boolean;
  /** 挂载工作空间自己的技能目录（`<workspace>/skills`）；旧档缺省视为 true */
  includeWorkspaceSkills?: boolean;
  includeExternalClaudeSkills: boolean;
  includeExternalCodexSkills: boolean;
  includeExternalPluginSkills: boolean;
  target: "session" | string;
}

export interface LaunchProfileSkill {
  id: string;
  name: string;
  description?: string | null;
  content: string;
}

export interface LaunchProfile {
  id: string;
  name: string;
  alias?: string | null;
  description?: string | null;
  providerId?: string | null;
  /** 供应商下的账号；不指定时用供应商的默认账号。 */
  providerAccountId?: string | null;
  modelId?: string | null;
  adapterOptions?: LaunchProfileAdapterOptions;
  targetTools: string[];
  /**
   * @deprecated 运行配置本机 / WSL / SSH 通用：后端忽略该字段并恒存 null。
   * 仅为线上兼容保留（旧数据可能带值），前端不得据此过滤或展示。
   */
  targetRuntime?: LaunchProfileRuntime;
  yoloMode?: boolean;
  mcpPolicy: LaunchProfileMcpPolicy;
  skillPolicy: LaunchProfileSkillPolicy;
  /** 原生 CLI 配置覆盖片段：叠在中转站片段之上、CC-Panes 显式字段之下。 */
  nativeOverrides?: NativeOverrides;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchProfileConfig {
  schemaVersion: number;
  profiles: LaunchProfile[];
}

export type LaunchProfileDraft = Omit<LaunchProfile, "id" | "createdAt" | "updatedAt"> & {
  name?: string;
};

export interface LaunchProfilePreviewRequest {
  profileId?: string | null;
  useSystemDefault?: boolean;
  workspaceName?: string | null;
  projectId?: string | null;
  providerId?: string | null;
  /** 供应商下的账号；不指定时用供应商的默认账号。 */
  providerAccountId?: string | null;
  modelId?: string | null;
  providerSelection?: LaunchProviderSelection;
  cliTool?: string | null;
  runtimeKind?: LaunchProfileRuntime;
}

export interface ResolvedMcpServer {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  url?: string | null;
}

export interface ResolvedSkill {
  id: string;
  name: string;
  source: "builtin" | "profile" | "project" | "user" | string;
  enabled: boolean;
  projectId?: string | null;
  projectPath?: string | null;
}

export type SkillCompatibilityReason =
  | "cliNotRegistered"
  | "noSkillDelivery"
  | "mcpUnsupported"
  | "ccpanesMcpDisabled";

export interface SkillCompatibility {
  cliTool: string;
  deliveryModes: SkillDeliveryMode[];
  canUsePortableSkills: boolean;
  canControlOrchestration: boolean;
  canReportResult: boolean;
  reason?: SkillCompatibilityReason | null;
}

export interface LaunchProfileResolution {
  profileId?: string | null;
  profileName?: string | null;
  profileAlias?: string | null;
  providerId?: string | null;
  /** 供应商下的账号；不指定时用供应商的默认账号。 */
  providerAccountId?: string | null;
  providerName?: string | null;
  providerAccountName?: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  modelSource?: "request" | "launchProfile" | "providerDefault" | "nativeDefault" | null;
  mcpServers: ResolvedMcpServer[];
  skills: ResolvedSkill[];
  skillCompatibility?: SkillCompatibility | null;
  warnings: string[];
  degraded: boolean;
}

export function defaultLaunchProfileDraft(provider?: Provider | null): LaunchProfileDraft {
  // 默认名创建时取当前语言并作为数据持久化（与布局默认名同一策略）
  const defaultName = provider
    ? i18n.t("profileDefaultName", { ns: "providers", tool: provider.name })
    : i18n.t("profileNewName", { ns: "providers" });
  return {
    name: defaultName,
    alias: defaultName,
    description: "",
    providerId: provider?.id ?? null,
    modelId: null,
    adapterOptions: {},
    targetTools: [],
    targetRuntime: null,
    yoloMode: false,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
      delivery: "direct",
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeWorkspaceSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
  };
}
