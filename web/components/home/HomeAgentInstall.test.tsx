import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacesStore } from "@/stores";
import HomeAgentInstall from "./HomeAgentInstall";
import { AGENT_CATALOG, installMethodsFor, terminalRunCommand } from "./agentCatalog";

const mocks = vi.hoisted(() => ({
  run: vi.fn(async (open: () => void, _command: string) => {
    open();
    return "sent" as const;
  }),
}));

vi.mock("./installTerminal", () => ({ runCommandInNewTerminal: mocks.run }));
vi.mock("./agentCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentCatalog")>();
  return { ...actual, currentInstallPlatform: () => "mac" as const };
});
vi.mock("./agentPromptLaunch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentPromptLaunch")>();
  return { ...actual, resolveDefaultAgentCwd: () => "/tmp/project" };
});
vi.mock("@/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services")>();
  return {
    ...actual,
    terminalService: {
      ...actual.terminalService,
      checkEnvironment: vi.fn(async () => ({
        node: { installed: true, version: "v22" },
        git: { installed: true, version: "2.0" },
        cliTools: [],
        packageManagers: { brew: false, npm: true, bun: false, curl: true },
        claude: { installed: false, version: null },
        codex: { installed: false, version: null },
      })),
    },
  };
});

const codex = AGENT_CATALOG.find((entry) => entry.id === "codex")!;

describe("agentCatalog 包管理器探测", () => {
  it("本机缺的方式排到后面，未上报时保持官方顺序", () => {
    const opencode = AGENT_CATALOG.find((entry) => entry.id === "opencode")!;
    expect(installMethodsFor(opencode, "mac", { brew: false, npm: true, curl: true }).map((m) => m.label)).toEqual([
      "script",
      "npm",
      "Homebrew",
    ]);
    expect(installMethodsFor(codex, "mac").map((m) => m.label)).toEqual(["npm", "Homebrew"]);
  });

  it("Windows 的 irm 脚本包一层 powershell，其余命令原样", () => {
    expect(terminalRunCommand("irm https://x.ai/cli/install.ps1 | iex", "windows")).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"',
    );
    expect(terminalRunCommand("npm install -g @openai/codex", "windows")).toBe("npm install -g @openai/codex");
    expect(terminalRunCommand("irm https://x | iex", "mac")).toBe("irm https://x | iex");
  });

  it("条目 id 不重复，且每个条目在 Windows 上都有安装方式（含 Antigravity）", () => {
    const ids = AGENT_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("antigravity");
    for (const entry of AGENT_CATALOG) {
      expect(installMethodsFor(entry, "windows").length, entry.id).toBeGreaterThan(0);
    }
  });
});

describe("HomeAgentInstall", () => {
  beforeEach(() => {
    mocks.run.mockClear();
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it("提示缺 Homebrew、列出已检测到的工具，并在应用内终端执行安装命令", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    render(<HomeAgentInstall installedTools={[]} ready onOpenTerminal={onOpenTerminal} />);

    expect(await screen.findByText(/Homebrew/, { selector: "[role=status]" })).toBeInTheDocument();
    expect(screen.getByTestId("home-agent-install-detected")).toHaveTextContent("npm · curl");

    const row = document.querySelector('[data-agent-id="codex"]') as HTMLElement;
    const lines = row.querySelectorAll("[data-available]");
    expect(lines[0]).toHaveAttribute("data-available", "true");
    expect(lines[1]).toHaveAttribute("data-available", "false");
    const runButtons = within(row).getAllByTestId("home-agent-install-run");
    expect(runButtons[1]).toBeDisabled();

    await user.click(runButtons[0]);
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][1]).toBe("npm install -g @openai/codex");
    expect(onOpenTerminal).toHaveBeenCalledWith({ path: "/tmp/project" });
  });
});
