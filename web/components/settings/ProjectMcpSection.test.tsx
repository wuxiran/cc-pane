import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useDescriptionLangStore, useMcpStore } from "@/stores";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { createTestWorkspace } from "@/test/utils/testData";
import type { LaunchProfile, LaunchProfileDraft, McpServerConfig, SharedMcpServerInfo } from "@/types";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import ProjectMcpSection from "./ProjectMcpSection";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const loadServersMock = vi.fn(async () => {});
const loadLegacyServersMock = vi.fn(async () => {});
const importLegacyServersMock = vi.fn(async () => ["legacy"]);
const upsertServerMock = vi.fn(async () => {});
const removeServerMock = vi.fn(async () => true);
const startSharedMock = vi.fn(async () => {});
const stopSharedMock = vi.fn(async () => {});

const PROJECT = "D:/repo/demo";
const PROJECT_TARGET = { projectPath: PROJECT };

const profile: LaunchProfile = {
  id: "profile-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...defaultLaunchProfileDraft(),
  name: "Default",
  alias: "Default",
  isDefault: true,
};
const updateProfileMock = vi.fn<(id: string, draft: LaunchProfileDraft) => Promise<LaunchProfile>>(async () => profile);

const sharedFetch: SharedMcpServerInfo = {
  name: "fetch-shared",
  config: { command: "uvx", args: ["mcp-server-fetch"], env: {}, shared: true, port: 3100, bridgeMode: "mcp-proxy" },
  status: "stopped",
  pid: null,
  url: null,
  restartCount: 0,
};

function setServers(servers: Record<string, McpServerConfig>) {
  useMcpStore.setState({
    servers,
    legacyServers: {},
    loading: false,
    loadServers: loadServersMock,
    loadLegacyServers: loadLegacyServersMock,
    importLegacyServers: importLegacyServersMock,
    upsertServer: upsertServerMock,
    removeServer: removeServerMock,
  });
}

const translate = i18n.t as unknown as (key: string, opts?: Record<string, unknown>) => string;
const t = (key: string, opts?: Record<string, unknown>) => translate(`settings:${key}`, opts);
const tc = (key: string) => translate(`common:${key}`);

function card(name: string): HTMLElement {
  const el = document.querySelector(`[data-mcp-name="${name}"]`);
  if (!el) throw new Error(`card ${name} not rendered`);
  return el as HTMLElement;
}

async function openAddDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("mcp-add-card"));
  return screen.getByRole("dialog");
}

describe("ProjectMcpSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setServers({});
    useWorkspacesStore.setState({ workspaces: [createTestWorkspace({ name: "team", launchProfileId: "profile-1" })] });
    useLaunchProfilesStore.setState({
      profiles: [profile],
      load: vi.fn(async () => {}),
      update: updateProfileMock,
    });
    useSharedMcpStore.setState({
      servers: [sharedFetch],
      fetchStatus: vi.fn(async () => {}),
      startServer: startSharedMock,
      stopServer: stopSharedMock,
    });
  });

  it("loads servers for the project on mount", () => {
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(loadServersMock).toHaveBeenCalledWith(PROJECT_TARGET);
    expect(loadLegacyServersMock).toHaveBeenCalledWith(PROJECT);
  });

  it("lists what the launch profile injects even when this layer is empty", () => {
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(card("CC-Panes MCP")).toBeInTheDocument();
    expect(card("fetch-shared")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "CC-Panes MCP" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "fetch-shared" })).toBeChecked();
    // 本层空 → 网格里一张「添加」卡，而不是整页空态
    expect(screen.getByTestId("mcp-add-card")).toHaveTextContent(t("mcpNoServers"));
    expect(screen.getByText(t("mcpHubSummary", { injected: 2, layer: 0 }), { exact: false })).toBeInTheDocument();
  });

  it("flags a shared server that is enabled but not running and can start it", async () => {
    const user = userEvent.setup();
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const fetchCard = card("fetch-shared");
    expect(within(fetchCard).getByText(t("mcpEnabledNotRunning"))).toBeInTheDocument();
    await user.click(within(fetchCard).getByRole("button", { name: t("mcpStart") }));
    await waitFor(() => expect(startSharedMock).toHaveBeenCalledWith("fetch-shared"));
  });

  it("shows the failure message when a shared server has crashed", () => {
    useSharedMcpStore.setState({
      servers: [{ ...sharedFetch, status: { failed: { message: "Exited: ExitStatus(1)" } } }],
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const fetchCard = card("fetch-shared");
    expect(within(fetchCard).getByText(t("mcpStatus.failed"))).toBeInTheDocument();
    expect(within(fetchCard).getByTestId("mcp-card-failure")).toHaveTextContent("Exited: ExitStatus(1)");
  });

  it("toggling a shared server writes the launch profile", async () => {
    const user = userEvent.setup();
    render(<ProjectMcpSection projectPath={PROJECT} />);

    await user.click(screen.getByRole("switch", { name: "fetch-shared" }));
    await waitFor(() => expect(updateProfileMock).toHaveBeenCalled());
    const [id, draft] = updateProfileMock.mock.calls[0];
    expect(id).toBe("profile-1");
    expect(draft.mcpPolicy.disabledServerIds).toContain("fetch-shared");
  });

  it("filter chips narrow the grid to one source", async () => {
    const user = userEvent.setup();
    setServers({ own: { command: "node", args: [], env: {} } });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    await user.click(screen.getByRole("tab", { name: new RegExp(t("mcpOwnSection")) }));
    expect(document.querySelector('[data-mcp-name="own"]')).not.toBeNull();
    expect(document.querySelector('[data-mcp-name="fetch-shared"]')).toBeNull();

    await user.click(screen.getByRole("tab", { name: new RegExp(t("mcpProfileSection")) }));
    expect(document.querySelector('[data-mcp-name="own"]')).toBeNull();
    expect(screen.queryByTestId("mcp-add-card")).toBeNull();
  });

  it("warns about stdio-only reach when the workspace launches on WSL", () => {
    useWorkspacesStore.setState({
      workspaces: [createTestWorkspace({ name: "team", launchProfileId: "profile-1", cliEnvironmentDefaults: { codex: "wsl" } })],
    });
    render(<ProjectMcpSection projectPath="" workspaceName="team" />);
    expect(screen.getByTestId("remote-runtime-notice")).toHaveTextContent("WSL");
  });

  it("shows a loading spinner while servers are loading", () => {
    useMcpStore.setState({ loading: true });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("renders each layer server with command line and env keys only", () => {
    setServers({
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { API_KEY: "secret" },
      },
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const c7 = card("context7");
    expect(within(c7).getByText("npx -y @upstash/context7-mcp")).toBeInTheDocument();
    expect(within(c7).getByText("API_KEY")).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("rejects saving when name or command is empty", async () => {
    const user = userEvent.setup();
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole("button", { name: tc("save") }));

    expect(toast.error).toHaveBeenCalled();
    expect(upsertServerMock).not.toHaveBeenCalled();
  });

  it("saves a new server with whitespace-split args, descriptions and parsed env lines", async () => {
    const user = userEvent.setup();
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByPlaceholderText(t("mcpServerNamePlaceholder")), "  my-server  ");
    await user.type(within(dialog).getByPlaceholderText(t("mcpCommandPlaceholder")), "npx");
    await user.type(within(dialog).getByPlaceholderText(t("mcpArgsPlaceholder")), "-y   some-pkg");
    const [zh] = within(dialog).getAllByPlaceholderText(t("mcpDescriptionPlaceholder"));
    await user.type(zh, " 装依赖 ");
    await user.type(dialog.querySelector("textarea") as HTMLTextAreaElement, "KEY=VALUE{enter}FOO=BAR");
    await user.click(within(dialog).getByRole("button", { name: tc("save") }));

    await waitFor(() =>
      expect(upsertServerMock).toHaveBeenCalledWith(
        PROJECT_TARGET,
        "my-server",
        "npx",
        ["-y", "some-pkg"],
        { KEY: "VALUE", FOO: "BAR" },
        { "zh-CN": "装依赖", en: "" },
      ),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("removes the old entry first when a server is renamed", async () => {
    const user = userEvent.setup();
    setServers({ "old-name": { command: "npx", args: [], env: {} } });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    await user.click(within(card("old-name")).getByRole("button", { name: t("mcpEdit") }));
    const dialog = screen.getByRole("dialog");
    const nameInput = within(dialog).getByDisplayValue("old-name");
    await user.clear(nameInput);
    await user.type(nameInput, "new-name");
    await user.click(within(dialog).getByRole("button", { name: tc("save") }));

    await waitFor(() => expect(removeServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "old-name"));
    expect(upsertServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "new-name", "npx", [], {}, { "zh-CN": "", en: "" });
  });

  it("shows the description for the chosen language and switches with the toggle", async () => {
    const user = userEvent.setup();
    useDescriptionLangStore.setState({ preference: "zh-CN" });
    setServers({
      docs: { command: "npx", args: [], env: {}, descriptions: { "zh-CN": "查文档", en: "Look up docs" } },
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(screen.getByText("查文档")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "EN" }));
    expect(screen.getByText("Look up docs")).toBeInTheDocument();
    expect(screen.queryByText("查文档")).not.toBeInTheDocument();
  });

  it("deletes a server via its trash button", async () => {
    const user = userEvent.setup();
    setServers({ doomed: { command: "npx", args: [], env: {} } });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    await user.click(within(card("doomed")).getByRole("button", { name: t("mcpDelete") }));

    await waitFor(() => expect(removeServerMock).toHaveBeenCalledWith(PROJECT_TARGET, "doomed"));
    expect(toast.success).toHaveBeenCalled();
  });

  it("workspace view loads the workspace layer and never touches legacy servers", () => {
    render(<ProjectMcpSection projectPath="" workspaceName="team" />);

    expect(loadServersMock).toHaveBeenCalledWith({ workspaceName: "team" });
    expect(loadLegacyServersMock).not.toHaveBeenCalled();
    expect(screen.getByText(/team/)).toBeInTheDocument();
  });

  it("offers a one-click import when legacy .claude servers are not in the overlay yet", async () => {
    const user = userEvent.setup();
    setServers({ kept: { command: "npx", args: [], env: {} } });
    useMcpStore.setState({
      legacyServers: {
        kept: { command: "npx", args: [], env: {} },
        legacy: { command: "old", args: [], env: {} },
      },
    });
    render(<ProjectMcpSection projectPath={PROJECT} />);

    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.queryByText("kept, legacy")).not.toBeInTheDocument();

    // 项目不属于任何工作空间 → 导入到项目覆盖层（workspaceName 为 undefined）
    await user.click(screen.getByRole("button", { name: t("mcpLegacyImportToProject") }));
    await waitFor(() => expect(importLegacyServersMock).toHaveBeenCalledWith(PROJECT, undefined));
    expect(toast.success).toHaveBeenCalled();
    expect(loadLegacyServersMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces service failures through an error toast", async () => {
    const user = userEvent.setup();
    upsertServerMock.mockRejectedValueOnce(new Error("io error"));
    render(<ProjectMcpSection projectPath={PROJECT} />);

    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByPlaceholderText(t("mcpServerNamePlaceholder")), "srv");
    await user.type(within(dialog).getByPlaceholderText(t("mcpCommandPlaceholder")), "cmd");
    await user.click(within(dialog).getByRole("button", { name: tc("save") }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
