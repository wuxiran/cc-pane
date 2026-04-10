import type { KnownCliTool, WorkspaceLaunchEnvironment } from "@/types";

export type SidebarLaunchCliTool = Exclude<KnownCliTool, "none">;

export interface SidebarCliLaunchItem {
  key: string;
  cliTool: SidebarLaunchCliTool;
  environment: Extract<WorkspaceLaunchEnvironment, "local" | "wsl">;
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

export function buildSidebarCliLaunchItems(
  t: any,
  includeWslVariant: boolean,
): SidebarCliLaunchItem[] {
  return SIDEBAR_LAUNCH_CLI_TOOLS.flatMap((tool) => {
    const label = t(tool.labelKey, { ns: "sidebar" });
    const items: SidebarCliLaunchItem[] = [
      {
        key: `${tool.id}-local`,
        cliTool: tool.id,
        environment: "local",
        label,
      },
    ];

    if (includeWslVariant) {
      items.push({
        key: `${tool.id}-wsl`,
        cliTool: tool.id,
        environment: "wsl",
        label: t("cliWslVariant", {
          ns: "sidebar",
          label,
          defaultValue: `${label} (WSL)`,
        }),
      });
    }

    return items;
  });
}
