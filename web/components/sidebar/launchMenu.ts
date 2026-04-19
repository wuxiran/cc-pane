import type { KnownCliTool, WorkspaceLaunchEnvironment } from "@/types";

export type SidebarLaunchCliTool = Exclude<KnownCliTool, "none">;
export type SidebarLaunchActionEnvironment = Extract<WorkspaceLaunchEnvironment, "local" | "wsl">;
export type SidebarLaunchActionId =
  | "terminal-default"
  | "terminal-wsl"
  | `${SidebarLaunchCliTool}-local`
  | `${SidebarLaunchCliTool}-wsl`;

export interface SidebarLaunchAction {
  id: SidebarLaunchActionId;
  cliTool?: SidebarLaunchCliTool;
  environment?: SidebarLaunchActionEnvironment;
  kind: "terminal" | "cli";
  label: string;
}

export interface SidebarCliLaunchItem {
  key: string;
  cliTool: SidebarLaunchCliTool;
  environment: SidebarLaunchActionEnvironment;
  label: string;
}

const SIDEBAR_LAUNCH_CLI_TOOLS: ReadonlyArray<{
  id: SidebarLaunchCliTool;
  labelKey: string;
}> = [
  { id: "claude", labelKey: "cliToolClaude" },
  { id: "codex", labelKey: "cliToolCodex" },
  { id: "gemini", labelKey: "cliToolGemini" },
  { id: "kimi", labelKey: "cliToolKimi" },
  { id: "glm", labelKey: "cliToolGlm" },
  { id: "opencode", labelKey: "cliToolOpenCode" },
];

export function getDefaultSidebarFavoriteLaunchActionIds(): SidebarLaunchActionId[] {
  return ["terminal-default", "claude-local", "codex-local"];
}

export function buildSidebarLaunchActions(
  t: any,
  includeWslVariant: boolean,
): SidebarLaunchAction[] {
  const terminalLabel = t("openTerminal", { ns: "sidebar" });
  const actions: SidebarLaunchAction[] = [
    {
      id: "terminal-default",
      kind: "terminal",
      label: terminalLabel,
    },
  ];

  if (includeWslVariant) {
    actions.push({
      id: "terminal-wsl",
      kind: "terminal",
      environment: "wsl",
      label: t("cliWslVariant", {
        ns: "sidebar",
        label: terminalLabel,
        defaultValue: `${terminalLabel} (WSL)`,
      }),
    });
  }

  for (const tool of SIDEBAR_LAUNCH_CLI_TOOLS) {
    const label = t(tool.labelKey, { ns: "sidebar" });
    actions.push({
      id: `${tool.id}-local`,
      kind: "cli",
      cliTool: tool.id,
      environment: "local",
      label,
    });
    if (includeWslVariant) {
      actions.push({
        id: `${tool.id}-wsl`,
        kind: "cli",
        cliTool: tool.id,
        environment: "wsl",
        label: t("cliWslVariant", {
          ns: "sidebar",
          label,
          defaultValue: `${label} (WSL)`,
        }),
      });
    }
  }

  return actions;
}

export function filterSidebarFavoriteLaunchActions(
  actions: SidebarLaunchAction[],
  favoriteIds: string[],
): SidebarLaunchAction[] {
  const actionMap = new Map(actions.map((action) => [action.id, action]));
  return favoriteIds
    .map((favoriteId) => actionMap.get(favoriteId as SidebarLaunchActionId))
    .filter((action): action is SidebarLaunchAction => action !== undefined);
}

export function buildSidebarCliLaunchItems(
  t: any,
  includeWslVariant: boolean,
): SidebarCliLaunchItem[] {
  return buildSidebarLaunchActions(t, includeWslVariant)
    .filter((action): action is SidebarLaunchAction & { cliTool: SidebarLaunchCliTool; environment: SidebarLaunchActionEnvironment } =>
      action.kind === "cli" && !!action.cliTool && !!action.environment,
    )
    .map((action) => ({
      key: action.id,
      cliTool: action.cliTool,
      environment: action.environment,
      label: action.label,
    }));
}
