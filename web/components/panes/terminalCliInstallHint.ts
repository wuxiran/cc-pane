const CLI_INSTALL_HINTS: Record<string, string> = {
  opencode:
    "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org",
};

export function getCliInstallHint(toolName: string): string | null {
  const key = toolName.trim().toLowerCase();
  return CLI_INSTALL_HINTS[key] ?? null;
}
