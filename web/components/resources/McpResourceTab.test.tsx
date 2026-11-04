import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useMcpStore } from "@/stores/useMcpStore";
import { useSharedMcpStore } from "@/stores/useSharedMcpStore";
import { mcpTargetKey, type LaunchProfile, type LaunchProfileDraft } from "@/types";
import type { SharedMcpServerConfig, SharedMcpServerInfo } from "@/types/shared-mcp";
import McpResourceTab from "./McpResourceTab";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const config: SharedMcpServerConfig = { command: "npx", args: ["-y", "gh"], env: {}, shared: true, port: 3100, bridgeMode: "mcp-proxy" };
const server = (name: string, status: SharedMcpServerInfo["status"] = "running"): SharedMcpServerInfo =>
  ({ name, config, status, pid: 1, url: null, restartCount: 0 }) as SharedMcpServerInfo;

const profile = (id: string, over: Partial<LaunchProfile["mcpPolicy"]> = {}): LaunchProfile => ({
  id,
  name: id,
  targetTools: ["claude", "codex"],
  mcpPolicy: { mode: "default", enabledServerIds: [], disabledServerIds: [], includeCcpanesMcp: true, includeSharedMcp: true, ...over },
  skillPolicy: {
    mode: "core", enabledSkillIds: [], disabledSkillIds: [], profileSkills: [], includeProjectSkills: true,
    includeExternalClaudeSkills: true, includeExternalCodexSkills: true, includeExternalPluginSkills: true, target: "session",
  },
  isDefault: false,
}) as unknown as LaunchProfile;

const row = (name: string) => document.querySelector(`[data-resource-name="${name}"]`) as HTMLElement;
const chip = (name: string, id: string) => row(name).querySelector(`[data-profile-id="${id}"]`) as HTMLElement;

describe("McpResourceTab", () => {
  const update = vi.fn();
  const upsertShared = vi.fn();
  const upsertLayer = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    update.mockImplementation(async (id: string, draft: LaunchProfileDraft) => {
      const current = useLaunchProfilesStore.getState().profiles;
      const next = current.map((item) => (item.id === id ? ({ ...item, mcpPolicy: draft.mcpPolicy } as LaunchProfile) : item));
      useLaunchProfilesStore.setState({ profiles: next });
      return next.find((item) => item.id === id)!;
    });
    useLaunchProfilesStore.setState({ profiles: [profile("a"), profile("b")], update, load: vi.fn().mockResolvedValue(undefined) });
    useSharedMcpStore.setState({
      servers: [server("github")],
      config: { servers: {}, portRangeStart: 3100, portRangeEnd: 3200 } as never,
      fetchStatus: vi.fn().mockResolvedValue(undefined),
      fetchConfig: vi.fn().mockResolvedValue(undefined),
      upsertServer: upsertShared.mockResolvedValue(undefined),
    });
    useMcpStore.setState({ layers: {}, upsertServer: upsertLayer.mockResolvedValue(undefined), loadServers: vi.fn().mockResolvedValue(undefined) } as never);
  });

  const renderTab = (props: Partial<Parameters<typeof McpResourceTab>[0]> = {}) => {
    const profiles = useLaunchProfilesStore.getState().profiles;
    return render(<McpResourceTab profiles={profiles} layerTarget={null} layerLabel={null} {...props} />);
  };

  it("writes a chip click to that profile only and says when it applies", async () => {
    renderTab();
    expect(chip("github", "a").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("github", "a"));

    expect(chip("github", "a").getAttribute("aria-pressed")).toBe("false");
    expect(within(row("github")).getByTestId("resource-row-notice").textContent).toBe("resourceCenter.nextLaunch");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe("a");
    expect(update.mock.calls[0][1].mcpPolicy.disabledServerIds).toEqual(["github"]);
  });

  it("All only touches profiles that aren't in the wanted state yet", async () => {
    useLaunchProfilesStore.setState({ profiles: [profile("a"), profile("b", { disabledServerIds: ["github"] })] });
    renderTab();

    fireEvent.click(within(row("github")).getByTestId("profile-chip-all"));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe("b");
    expect(update.mock.calls[0][1].mcpPolicy.disabledServerIds).toEqual([]);
  });

  it("explains a blocked chip on the row and writes nothing", () => {
    useLaunchProfilesStore.setState({ profiles: [profile("a", { mode: "disabled" }), profile("b")] });
    renderTab();

    const blocked = chip("github", "a");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(blocked);

    expect(within(row("github")).getByTestId("resource-row-notice").textContent).toBe("resourceCenter.blocked.mcpDisabled");
    expect(update).not.toHaveBeenCalled();
  });

  it("shows a failure's reason on the row", () => {
    useSharedMcpStore.setState({ servers: [server("github", { failed: { message: "Exited: 1" } })] });
    renderTab();
    expect(within(row("github")).getByTestId("resource-row-failure").textContent).toBe("Exited: 1");
  });

  it("shows layer servers as locked, with no profile switches", () => {
    const target = { workspaceName: "w" };
    useMcpStore.setState({
      layers: { [mcpTargetKey(target)]: { servers: { local: { command: "node", args: ["a.js"], env: {} } }, legacyServers: {}, loading: false } },
    } as never);
    renderTab({ layerTarget: target, layerLabel: "w" });
    expect(row("local").querySelector("[data-testid=profile-chip]")).toBeNull();
    expect(within(row("local")).getByText("resourceCenter.notProfileControlled")).toBeTruthy();
  });

  describe("paste", () => {
    const paste = (text: string) => {
      fireEvent.click(screen.getByTestId("mcp-paste-open"));
      fireEvent.change(screen.getByTestId("mcp-paste-input"), { target: { value: text } });
    };

    it("adds to shared MCP with a free port from the configured range", async () => {
      renderTab();
      paste(`{"mcpServers":{"docs":{"command":"uvx","args":["docs"],"env":{"API_KEY":"s3cret"}}}}`);
      expect(screen.getByTestId("mcp-paste-row").textContent).not.toContain("s3cret");

      fireEvent.click(screen.getByTestId("mcp-paste-add"));

      await waitFor(() => expect(upsertShared).toHaveBeenCalledTimes(1));
      expect(upsertShared.mock.calls[0][0]).toBe("docs");
      expect(upsertShared.mock.calls[0][1]).toMatchObject({ command: "uvx", args: ["docs"], env: { API_KEY: "s3cret" }, port: 3101 });
    });

    it("won't overwrite a server of the same name until it is renamed", async () => {
      renderTab();
      paste(`{"mcpServers":{"github":{"command":"x"}}}`);
      expect((screen.getByTestId("mcp-paste-add") as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(within(screen.getByTestId("mcp-paste-row")).getByRole("textbox"), { target: { value: "github-2" } });
      fireEvent.click(screen.getByTestId("mcp-paste-add"));

      await waitFor(() => expect(upsertShared).toHaveBeenCalledTimes(1));
      expect(upsertShared.mock.calls[0][0]).toBe("github-2");
    });

    it("refuses a remote entry, because the write API can't keep its url", () => {
      renderTab();
      paste(`{"mcpServers":{"r":{"url":"https://x/mcp"}}}`);
      expect(within(screen.getByTestId("mcp-paste-row")).getByText("resourceCenter.paste.problem.remote")).toBeTruthy();
      expect((screen.getByTestId("mcp-paste-add") as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps the dialog open and reports when a write fails", async () => {
      upsertShared.mockRejectedValueOnce(new Error("disk full"));
      renderTab();
      paste(`{"mcpServers":{"docs":{"command":"uvx"}}}`);
      fireEvent.click(screen.getByTestId("mcp-paste-add"));
      await waitFor(() => expect(upsertShared).toHaveBeenCalled());
      expect(screen.getByTestId("mcp-paste-input")).toBeTruthy();
    });

    it("shows why the text couldn't be read", () => {
      renderTab();
      paste("nonsense");
      expect(screen.getByTestId("mcp-paste-error").textContent).toBe("resourceCenter.paste.error.invalidJson");
    });
  });
});
