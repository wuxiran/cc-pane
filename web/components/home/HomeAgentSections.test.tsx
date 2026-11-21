import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogStore, useHomePreferencesStore, useProvidersStore } from "@/stores";
import { SYSTEM_PROVIDER_ID, type Provider } from "@/types/provider";
import type { CliToolInfo } from "@/types";
import HomeAgentList from "./HomeAgentList";
import HomeAgentInstall from "./HomeAgentInstall";
import HomeQuickStart from "./HomeQuickStart";
import { useHomeSetupDialogStore } from "./homeSetupDialogStore";
import { AGENT_CATALOG, installMethodsFor, pendingCatalogEntries, primaryInstallCommand } from "./agentCatalog";

const guide = vi.hoisted(() => ({
  state: {
    items: [] as Array<{ id: string; complete: boolean; action: () => void; guidePath: string }>,
    completed: 0,
    nextItem: null as null | { id: string; complete: boolean; action: () => void; guidePath: string },
    skillCheckFailed: false,
  },
}));

vi.mock("@/components/onboarding/useSetupGuideItems", () => ({
  useSetupGuideItems: () => guide.state,
  openOnboarding: vi.fn(),
}));
vi.mock("@/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services")>();
  return {
    ...actual,
    terminalService: {
      ...actual.terminalService,
      checkEnvironment: vi.fn(async () => ({
        node: { installed: false, version: null },
        git: { installed: true, version: "2.0" },
        cliTools: [],
        claude: { installed: false, version: null },
        codex: { installed: false, version: null },
      })),
    },
  };
});

function tool(id: string, displayName: string, version = "1.0.0"): CliToolInfo {
  return { id, displayName, executable: id, versionArgs: [], installed: true, version, path: `/bin/${id}` };
}

function provider(id: string, name: string): Provider {
  return { id, name, providerType: "anthropic", isDefault: false } as Provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  useHomePreferencesStore.setState({ quickStartDismissed: false });
  useDialogStore.setState({ launcherOpen: false, launcherContext: null });
  const steps = ["workspace", "project", "multiLaunch", "dispatch", "skill"].map((id, index) => ({
    id,
    complete: index < 2,
    action: vi.fn(),
    guidePath: `docs/${id}.md`,
  }));
  guide.state = { items: steps, completed: 2, nextItem: steps[2], skillCheckFailed: false };
});

describe("HomeQuickStart", () => {
  it("shows progress, marks the next step, and launches a CLI from its chip", async () => {
    const user = userEvent.setup();
    render(<HomeQuickStart installedTools={[tool("codex", "Codex")]} />);

    const card = screen.getByTestId("home-quick-start");
    expect(within(card).getByText(/2\/5/)).toBeInTheDocument();
    expect(card.querySelector('[data-step-id="workspace"]')).toHaveAttribute("data-complete", "true");
    await user.click(within(card).getByRole("button", { name: /Codex/ }));
    expect(useDialogStore.getState().launcherOpen).toBe(true);
    expect(useDialogStore.getState().launcherContext).toEqual({ cliTool: "codex" });
  });

  it("can go back to an earlier (completed) step with the arrows or by clicking it", async () => {
    const user = userEvent.setup();
    render(<HomeQuickStart installedTools={[]} />);
    const card = screen.getByTestId("home-quick-start");
    expect(card.querySelector('[data-step-id="multiLaunch"]')).toHaveAttribute("aria-current", "step");

    await user.click(within(card).getByRole("button", { name: /上一步|Previous step/ }));
    expect(card.querySelector('[data-step-id="project"]')).toHaveAttribute("aria-current", "step");
    // 导入项目在首页弹框里就地完成，不再走共享清单的跳转
    await user.click(within(card).getByRole("button", { name: /去导入|Import/ }));
    expect(useHomeSetupDialogStore.getState().mode).toBe("project");
    expect(guide.state.items[1].action).not.toHaveBeenCalled();

    await user.click(card.querySelector('[data-step-id="workspace"]') as HTMLElement);
    expect(card.querySelector('[data-step-id="workspace"]')).toHaveAttribute("aria-current", "step");
    expect(within(card).getByRole("button", { name: /上一步|Previous step/ })).toBeDisabled();
  });

  it("disappears when dismissed and when every step is done", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<HomeQuickStart installedTools={[]} />);
    await user.click(screen.getByTestId("home-quick-start-dismiss"));
    expect(screen.queryByTestId("home-quick-start")).not.toBeInTheDocument();
    expect(useHomePreferencesStore.getState().quickStartDismissed).toBe(true);

    useHomePreferencesStore.setState({ quickStartDismissed: false });
    guide.state = { ...guide.state, nextItem: null, completed: 5 };
    rerender(<HomeQuickStart installedTools={[]} />);
    expect(screen.queryByTestId("home-quick-start")).not.toBeInTheDocument();
  });
});

describe("HomeAgentList", () => {
  const setDefault = vi.fn(async () => undefined);

  beforeEach(() => {
    useProvidersStore.setState({
      providers: [provider("p1", "Anthropic 官方"), provider("p2", "备用中转")],
      defaultProviderIds: { claude: "p2", codex: SYSTEM_PROVIDER_ID },
      systemActive: false,
      loadProviders: vi.fn(async () => undefined),
      setDefault,
    });
  });

  it("describes each agent's provider and changes the default from the dropdown", async () => {
    const user = userEvent.setup();
    const tools = [tool("claude", "Claude Code", "2.1.0"), tool("codex", "Codex")];
    render(<HomeAgentList tools={tools} installedTools={tools} loading={false} onRefresh={vi.fn()} />);

    const rows = screen.getAllByTestId("home-agent-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("2.1.0")).toBeInTheDocument();
    expect(within(rows[0]).getAllByText(/备用中转/).length).toBeGreaterThan(0);
    expect(within(rows[1]).getByText(/Codex/, { selector: "span.truncate[title]" })).toBeInTheDocument();

    await user.click(within(rows[0]).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Anthropic 官方" }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith("p1", "claude"));
  });

  it("launches the launcher with the row's CLI preselected", async () => {
    const user = userEvent.setup();
    const tools = [tool("gemini", "Gemini CLI")];
    render(<HomeAgentList tools={tools} installedTools={tools} loading={false} onRefresh={vi.fn()} />);

    await user.click(within(screen.getByTestId("home-agent-row")).getByRole("button", { name: /启动|Launch/ }));
    expect(useDialogStore.getState().launcherContext).toEqual({ cliTool: "gemini" });
  });
});

describe("HomeAgentInstall", () => {
  it("lists only agents that are not installed, with copyable commands and a Node warning", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<HomeAgentInstall installedTools={[tool("claude", "Claude Code")]} ready onOpenTerminal={vi.fn()} />);

    const section = screen.getByTestId("home-agent-install");
    const ids = within(section).getAllByTestId("home-agent-install-row").map((row) => row.dataset.agentId);
    expect(ids).not.toContain("claude");
    expect(ids).toContain("codex");
    expect(await within(section).findByRole("status")).toHaveTextContent(/Node\.js/);

    const codexRow = section.querySelector('[data-agent-id="codex"]') as HTMLElement;
    const command = within(codexRow).getAllByTestId("home-agent-install-command")[0].textContent ?? "";
    await user.click(within(codexRow).getAllByRole("button", { name: /复制命令|Copy command/ })[0]);
    expect(writeText).toHaveBeenCalledWith(command);
  });

  it("collapses from its header", async () => {
    const user = userEvent.setup();
    render(<HomeAgentInstall installedTools={[]} ready onOpenTerminal={vi.fn()} />);
    const toggle = screen.getByRole("button", { expanded: true });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("home-agent-install-row")).toHaveLength(0);
  });
});

describe("agentCatalog", () => {
  it("gives every entry at least one command on each platform it lists, and no duplicate ids", () => {
    const ids = AGENT_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of AGENT_CATALOG) {
      expect(entry.methods.length).toBeGreaterThan(0);
      expect(installMethodsFor(entry, "mac").length + installMethodsFor(entry, "windows").length).toBeGreaterThan(0);
    }
  });

  it("filters installed agents and exposes a primary command for the preflight card", () => {
    const pending = pendingCatalogEntries(new Set(["claude", "codex"]), "mac").map((entry) => entry.id);
    expect(pending).not.toContain("claude");
    expect(pending).toContain("gemini");
    expect(primaryInstallCommand("codex", "windows")).toBe("npm install -g @openai/codex");
    expect(primaryInstallCommand("not-a-cli", "mac")).toBeUndefined();
  });
});
