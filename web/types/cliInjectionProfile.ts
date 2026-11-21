// docs/110 批 0：各 CLI 注入能力描述（镜像 cc-cli-adapters/src/injection_profile.rs）。
export type McpChannel = "sessionFlag" | "sessionFile" | "projectFile" | "userFile" | "stdioProxy" | "none";
export type McpTransport = "stdioBridge" | "http" | "sse";
export type McpIsolation = "full" | "declareOnly" | "none";
export type SkillMount = "pluginDir" | "skillFlag" | "skillsDir" | "addDir" | "configArray" | "projectFile" | "none";
export type NativeSkillSource = "claude" | "codex" | "plugin";
export type RuntimeSupport = "full" | "partial" | "none";

export interface RuntimeInjection {
  launch: boolean;
  mcp: RuntimeSupport;
  skills: RuntimeSupport;
}

export interface InjectionProfile {
  mcp: {
    ccpanes: McpChannel;
    ctlProxy: boolean;
    shared: boolean;
    workspace: boolean;
    transports: McpTransport[];
    remoteHeaders: boolean;
    isolation: McpIsolation;
    launchIdentity: boolean;
  };
  skills: {
    mount: SkillMount;
    promptFallback: boolean;
    nativeSources: NativeSkillSource[];
  };
  runtimes: { wsl: RuntimeInjection; ssh: RuntimeInjection };
}

export type InjectionProfileMap = Record<string, InjectionProfile>;
