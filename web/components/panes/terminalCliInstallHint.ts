const KIRO_INSTALL_HINT =
  "Install Kiro CLI with: curl -fsSL https://cli.kiro.dev/install | bash, then run: kiro-cli login";
const ANTIGRAVITY_INSTALL_HINT =
  "Install Antigravity CLI with: curl -fsSL https://antigravity.google/cli/install.sh | bash (macOS/Linux) or irm https://antigravity.google/cli/install.ps1 | iex (Windows)";

const CLI_INSTALL_HINTS: Record<string, string> = {
  pi:
    "Install Pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  omp:
    "Install Oh My Pi with: irm https://omp.sh/install.ps1 | iex (Bun >= 1.3.14 required)",
  opencode:
    "Install OpenCode with: npm install -g opencode-ai --registry=https://registry.npmjs.org",
  jcode:
    "Install Jcode with: curl -fsSL https://jcode.sh/install | bash (macOS/Linux) or irm https://jcode.sh/install.ps1 | iex (Windows)",
  // 「未安装」报错里带的是可执行名（kiro-cli / agy），按可执行名与 CLI id 双键登记
  kiro: KIRO_INSTALL_HINT,
  "kiro-cli": KIRO_INSTALL_HINT,
  antigravity: ANTIGRAVITY_INSTALL_HINT,
  agy: ANTIGRAVITY_INSTALL_HINT,
  fx: "Install fx with: curl -fsSL https://fx.sh/setup.sh | bash (or Homebrew: fx-agent), then run: fx login",
  muse:
    "Install Muse Code with: curl -fsSL https://dev.meta.ai/install.sh | bash (macOS/Linux) or irm https://dev.meta.ai/install.ps1 | iex (Windows), then run: muse login",
};

export function getCliInstallHint(toolName: string): string | null {
  const key = toolName.trim().toLowerCase();
  return CLI_INSTALL_HINTS[key] ?? null;
}
