const CLI_INSTALL_HINTS: Record<string, string> = {
  pi:
    "Install Pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  omp:
    "Install Oh My Pi with: irm https://omp.sh/install.ps1 | iex (Bun >= 1.3.14 required)",
  opencode:
    "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org",
  jcode:
    "Install Jcode with: curl -fsSL https://jcode.sh/install | bash (macOS/Linux) or irm https://jcode.sh/install.ps1 | iex (Windows)",
  // 可执行名是 agy，终端里报 not found 的是 agy 而不是工具 id，两个键都登记
  antigravity:
    "Install Antigravity CLI with: curl -fsSL https://antigravity.google/cli/install.sh | bash (macOS/Linux) or irm https://antigravity.google/cli/install.ps1 | iex (Windows)",
  agy:
    "Install Antigravity CLI with: curl -fsSL https://antigravity.google/cli/install.sh | bash (macOS/Linux) or irm https://antigravity.google/cli/install.ps1 | iex (Windows)",
};

export function getCliInstallHint(toolName: string): string | null {
  const key = toolName.trim().toLowerCase();
  return CLI_INSTALL_HINTS[key] ?? null;
}
