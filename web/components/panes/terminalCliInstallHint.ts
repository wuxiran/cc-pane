const CLI_INSTALL_HINTS: Record<string, string> = {
  pi:
    "Install Pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  omp:
    "Install Oh My Pi with: irm https://omp.sh/install.ps1 | iex (Bun >= 1.3.14 required)",
  opencode:
    "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org",
};

export function getCliInstallHint(toolName: string): string | null {
  const key = toolName.trim().toLowerCase();
  return CLI_INSTALL_HINTS[key] ?? null;
}
