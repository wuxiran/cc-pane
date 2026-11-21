// 首页「安装其他 Agent」的推荐清单：每个 CLI 的官方安装方式。
// 命令逐条核对过官方文档（2026-11）；改动前先去官网对一遍，不要凭记忆改包名。
// 只列 CC-Panes 自己支持（能一键启动）的 CLI，id 与 KNOWN_CLI_TOOLS 对齐。
import type { PackageManagerId } from "@/types";

export type InstallPlatform = "mac" | "linux" | "windows";

export interface InstallMethod {
  /** 方式名（Homebrew / npm / 官方脚本…），专有名词不走 i18n；官方脚本用 i18n key 标记。 */
  label: string;
  command: string;
  platforms: readonly InstallPlatform[];
  /** 依赖的包管理器/工具；本机没有时这条排到后面并标「未检测到」。 */
  requires?: PackageManagerId;
}

export interface AgentCatalogEntry {
  id: string;
  name: string;
  homepage: string;
  methods: readonly InstallMethod[];
}

/** label 取这个值时，UI 显示 i18n 的「官方脚本」。 */
export const OFFICIAL_SCRIPT_LABEL = "script";

const UNIX: readonly InstallPlatform[] = ["mac", "linux"];
const WIN: readonly InstallPlatform[] = ["windows"];
const ALL: readonly InstallPlatform[] = ["mac", "linux", "windows"];

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    homepage: "https://code.claude.com/docs/en/setup",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://claude.ai/install.sh | bash", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm https://claude.ai/install.ps1 | iex", platforms: WIN },
      { label: "Homebrew", command: "brew install --cask claude-code", platforms: ["mac"], requires: "brew" },
      { label: "npm", command: "npm install -g @anthropic-ai/claude-code", platforms: ALL, requires: "npm" },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    homepage: "https://github.com/openai/codex",
    methods: [
      { label: "npm", command: "npm install -g @openai/codex", platforms: ALL, requires: "npm" },
      { label: "Homebrew", command: "brew install --cask codex", platforms: ["mac"], requires: "brew" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    homepage: "https://github.com/google-gemini/gemini-cli",
    methods: [
      { label: "Homebrew", command: "brew install gemini-cli", platforms: UNIX, requires: "brew" },
      { label: "npm", command: "npm install -g @google/gemini-cli", platforms: ALL, requires: "npm" },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    homepage: "https://opencode.ai/docs/",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://opencode.ai/install | bash", platforms: UNIX, requires: "curl" },
      { label: "Homebrew", command: "brew install anomalyco/tap/opencode", platforms: UNIX, requires: "brew" },
      { label: "Scoop", command: "scoop install opencode", platforms: WIN, requires: "scoop" },
      { label: "npm", command: "npm install -g opencode-ai", platforms: ALL, requires: "npm" },
    ],
  },
  {
    // Google 的终端 agent，二进制名 agy（2026-06 起取代个人版 Gemini CLI）。
    id: "antigravity",
    name: "Antigravity",
    homepage: "https://github.com/google-antigravity/antigravity-cli",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm https://antigravity.google/cli/install.ps1 | iex", platforms: WIN },
    ],
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    homepage: "https://cursor.com/cli",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl https://cursor.com/install -fsS | bash", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm 'https://cursor.com/install?win32=true' | iex", platforms: WIN },
    ],
  },
  {
    id: "kimi",
    name: "Kimi Code",
    homepage: "https://github.com/MoonshotAI/kimi-code",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm https://code.kimi.com/kimi-code/install.ps1 | iex", platforms: WIN },
    ],
  },
  {
    id: "grok",
    name: "Grok",
    homepage: "https://docs.x.ai/build/overview",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://x.ai/cli/install.sh | bash", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm https://x.ai/cli/install.ps1 | iex", platforms: WIN },
      { label: "npm", command: "npm install -g @xai-official/grok", platforms: ALL, requires: "npm" },
    ],
  },
  {
    id: "pi",
    name: "Pi",
    homepage: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
    methods: [
      { label: "npm", command: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent", platforms: ALL, requires: "npm" },
    ],
  },
  {
    id: "omp",
    name: "Oh My Pi",
    homepage: "https://omp.sh/docs/quickstart",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://omp.sh/install | sh", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm https://omp.sh/install.ps1 | iex", platforms: WIN },
      { label: "Homebrew", command: "brew install can1357/tap/omp", platforms: UNIX, requires: "brew" },
      { label: "Bun", command: "bun install -g @oh-my-pi/pi-coding-agent", platforms: ALL, requires: "bun" },
    ],
  },
  {
    id: "jcode",
    name: "JCode",
    homepage: "https://jcode.sh",
    methods: [
      { label: OFFICIAL_SCRIPT_LABEL, command: "curl -fsSL https://jcode.sh/install | bash", platforms: UNIX, requires: "curl" },
      { label: OFFICIAL_SCRIPT_LABEL, command: "irm https://jcode.sh/install.ps1 | iex", platforms: WIN },
    ],
  },
];

export function currentInstallPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "mac";
  const probe = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (probe.includes("win")) return "windows";
  if (probe.includes("mac")) return "mac";
  return "linux";
}

/** 本机包管理器探测结果；undefined = 旧后端未上报，一律当作可用。 */
export type PackageManagerAvailability = Partial<Record<PackageManagerId, boolean>> | undefined;

export function isMethodAvailable(method: InstallMethod, available: PackageManagerAvailability): boolean {
  if (!method.requires || !available) return true;
  return available[method.requires] !== false;
}

/** 当前平台可用的安装方式；给了探测结果时，本机能直接跑的排前面（同组内保持官方推荐顺序）。 */
export function installMethodsFor(
  entry: AgentCatalogEntry,
  platform: InstallPlatform,
  available?: PackageManagerAvailability,
): InstallMethod[] {
  const methods = entry.methods.filter((method) => method.platforms.includes(platform));
  return [
    ...methods.filter((method) => isMethodAvailable(method, available)),
    ...methods.filter((method) => !isMethodAvailable(method, available)),
  ];
}

/**
 * 在应用内终端里实际执行的命令。Windows 的 `irm … | iex` 只能在 PowerShell 里跑，
 * 而内置终端可能是 cmd / Git Bash，所以统一包一层 powershell；其余原样。
 */
export function terminalRunCommand(command: string, platform: InstallPlatform): string {
  if (platform !== "windows" || !command.startsWith("irm ")) return command;
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
}

/** 给其他入口（环境预检卡等）取一条首选安装命令。 */
export function primaryInstallCommand(id: string, platform: InstallPlatform = currentInstallPlatform()): string | undefined {
  const entry = AGENT_CATALOG.find((candidate) => candidate.id === id);
  return entry ? installMethodsFor(entry, platform)[0]?.command : undefined;
}

/** 推荐清单里、本机尚未安装的条目；已安装集合按 CLI id 判定。 */
export function pendingCatalogEntries(installedIds: ReadonlySet<string>, platform: InstallPlatform): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter(
    (entry) => !installedIds.has(entry.id) && installMethodsFor(entry, platform).length > 0,
  );
}
