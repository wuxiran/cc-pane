const CLI_INSTALL_HINTS: Record<string, string> = {
  pi:
    "Install Pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  opencode:
    "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org",
};

export function getCliInstallHint(toolName: string): string | null {
  const key = toolName.trim().toLowerCase();
  return CLI_INSTALL_HINTS[key] ?? null;
}
