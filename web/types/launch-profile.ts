import type { Provider } from "./provider";
import type { WorkspaceLaunchEnvironment } from "./workspace";

export type LaunchProfileMcpMode = "default" | "custom" | "disabled";
export type LaunchProfileSkillMode = "core" | "custom" | "disabled";
export type LaunchProviderSelection = "inherit" | "explicit" | "none";
export type LaunchProfileRuntime = WorkspaceLaunchEnvironment | null;
export type KimiConfigMode = "managed" | "native";

export interface LaunchProfileAdapterOptions {
  kimiConfigMode?: KimiConfigMode;
  [key: string]: unknown;
}

export interface LaunchProfileMcpPolicy {
  mode: LaunchProfileMcpMode;
  enabledServerIds: string[];
  disabledServerIds: string[];
  includeCcpanesMcp: boolean;
  includeSharedMcp: boolean;
}

export interface LaunchProfileSkillPolicy {
  mode: LaunchProfileSkillMode;
  enabledSkillIds: string[];
  disabledSkillIds: string[];
  profileSkills: LaunchProfileSkill[];
  includeProjectSkills: boolean;
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
  adapterOptions?: LaunchProfileAdapterOptions;
  targetTools: string[];
  targetRuntime?: LaunchProfileRuntime;
  mcpPolicy: LaunchProfileMcpPolicy;
  skillPolicy: LaunchProfileSkillPolicy;
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

export interface LaunchProfileResolution {
  profileId?: string | null;
  profileName?: string | null;
  profileAlias?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  mcpServers: ResolvedMcpServer[];
  skills: ResolvedSkill[];
  warnings: string[];
  degraded: boolean;
}

export function defaultLaunchProfileDraft(provider?: Provider | null): LaunchProfileDraft {
  return {
    name: provider ? `${provider.name} 运行配置` : "新运行配置",
    alias: provider ? `${provider.name} 运行配置` : "新运行配置",
    description: "",
    providerId: provider?.id ?? null,
    adapterOptions: {},
    targetTools: [],
    targetRuntime: null,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
  };
}
