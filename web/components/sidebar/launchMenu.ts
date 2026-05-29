import type { KnownCliTool, WorkspaceLaunchEnvironment } from "@/types";

export type SidebarLaunchCliTool = Exclude<KnownCliTool, "none">;
export type SidebarLaunchActionEnvironment = WorkspaceLaunchEnvironment;
export type SidebarLaunchActionId =
  | "terminal-default"
  | "terminal-local"
  | "terminal-wsl"
  | "terminal-ssh"
  | `${SidebarLaunchCliTool}-default`
  | `${SidebarLaunchCliTool}-local`
  | `${SidebarLaunchCliTool}-wsl`
  | `${SidebarLaunchCliTool}-ssh`;

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
  environment?: SidebarLaunchActionEnvironment;
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
  { id: "cursor", labelKey: "cliToolCursor" },
];

const LEGACY_DEFAULT_FAVORITES = ["terminal-default", "claude-local", "codex-local"];

export function getDefaultSidebarFavoriteLaunchActionIds(): SidebarLaunchActionId[] {
  return ["terminal-default", "claude-default", "codex-default"];
}

export function normalizeSidebarFavoriteLaunchActionIds(favoriteIds: string[]): string[] {
  if (
    favoriteIds.length === LEGACY_DEFAULT_FAVORITES.length
    && favoriteIds.every((id, index) => id === LEGACY_DEFAULT_FAVORITES[index])
  ) {
    return getDefaultSidebarFavoriteLaunchActionIds();
  }
  return favoriteIds;
}

export function buildSidebarLaunchActions(
  t: any,
  includeWslVariant: boolean,
  includeSshVariant = false,
): SidebarLaunchAction[] {
  const terminalLabel = t("openTerminal", { ns: "sidebar" });
  const actions: SidebarLaunchAction[] = [
    {
      id: "terminal-default",
      kind: "terminal",
      label: terminalLabel,
    },
    {
      id: "terminal-local",
      kind: "terminal",
      environment: "local",
      label: t("cliLocalVariant", {
        ns: "sidebar",
        label: terminalLabel,
        defaultValue: `${terminalLabel} (Local)`,
      }),
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
  if (includeSshVariant) {
    actions.push({
      id: "terminal-ssh",
      kind: "terminal",
      environment: "ssh",
      label: t("cliSshVariant", {
        ns: "sidebar",
        label: terminalLabel,
        defaultValue: `${terminalLabel} (SSH)`,
      }),
    });
  }

  for (const tool of SIDEBAR_LAUNCH_CLI_TOOLS) {
    const label = t(tool.labelKey, { ns: "sidebar" });
    actions.push({
      id: `${tool.id}-default`,
      kind: "cli",
      cliTool: tool.id,
      label,
    });
    actions.push({
      id: `${tool.id}-local`,
      kind: "cli",
      cliTool: tool.id,
      environment: "local",
      label: t("cliLocalVariant", {
        ns: "sidebar",
        label,
        defaultValue: `${label} (Local)`,
      }),
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
    if (includeSshVariant) {
      actions.push({
        id: `${tool.id}-ssh`,
        kind: "cli",
        cliTool: tool.id,
        environment: "ssh",
        label: t("cliSshVariant", {
          ns: "sidebar",
          label,
          defaultValue: `${label} (SSH)`,
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
  return normalizeSidebarFavoriteLaunchActionIds(favoriteIds)
    .map((favoriteId) => actionMap.get(favoriteId as SidebarLaunchActionId))
    .filter((action): action is SidebarLaunchAction => action !== undefined);
}

export function buildSidebarCliLaunchItems(
  t: any,
  includeWslVariant: boolean,
  includeSshVariant = false,
): SidebarCliLaunchItem[] {
  return buildSidebarLaunchActions(t, includeWslVariant, includeSshVariant)
    .filter((action): action is SidebarLaunchAction & { cliTool: SidebarLaunchCliTool } =>
      action.kind === "cli" && !!action.cliTool,
    )
    .map((action) => ({
      key: action.id,
      cliTool: action.cliTool,
      environment: action.environment,
      label: action.label,
    }));
}
