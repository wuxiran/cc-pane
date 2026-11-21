import "@/i18n";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCliTools } from "@/services/cliToolService";
import { historyService } from "@/services";
import type { CliToolInfo } from "@/types";
import LauncherCliRow from "./LauncherCliRow";
import LauncherProjectPicker from "./LauncherProjectPicker";
import LauncherAdvanced, { useAdvancedSummary } from "./LauncherAdvanced";
import { createDefaultDraft } from "./launcherModel";
import { loadCliPrefs, saveCliPrefs } from "./launcherPrefs";
import { resolveYoloSupport } from "./launcherCapabilities";

vi.mock("@/services/cliToolService", () => ({ listCliTools: vi.fn() }));

function tool(id: string, displayName: string, installed = true, supportsYolo?: boolean): CliToolInfo {
  return {
    id, displayName, executable: id, versionArgs: [], installed, version: null, path: null,
    ...(supportsYolo === undefined ? {} : { capabilities: { supportsYolo } }),
  } as CliToolInfo;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("LauncherCliRow", () => {
  it("lays out every installed CLI as a chip and shows YOLO only where the CLI supports it", async () => {
    vi.mocked(listCliTools).mockResolvedValue([
      tool("claude", "Claude Code", true, true),
      tool("codex", "Codex", true, true),
      tool("gemini", "Gemini CLI", true, true),
      tool("pi", "Pi", true, false),
      tool("kimi", "Kimi", false, false),
    ]);
    const onYoloChange = vi.fn();
    const { rerender } = render(<LauncherCliRow value="claude" onChange={vi.fn()} yolo={false} onYoloChange={onYoloChange} />);
    expect(await screen.findByRole("radio", { name: "Gemini CLI" })).toBeEnabled();
    expect(screen.queryByRole("radio", { name: "Kimi" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "YOLO" }));
    expect(onYoloChange).toHaveBeenCalledWith(true);

    rerender(<LauncherCliRow value="gemini" onChange={vi.fn()} yolo={false} onYoloChange={onYoloChange} />);
    expect(screen.getByRole("switch", { name: "YOLO" })).toBeEnabled();

    // Pi 本身不做权限确认：常开、不可关
    rerender(<LauncherCliRow value="pi" onChange={vi.fn()} yolo={false} onYoloChange={onYoloChange} />);
    const inherent = screen.getByRole("switch", { name: "YOLO" });
    expect(inherent).toBeDisabled();
    expect(inherent).toBeChecked();

    rerender(<LauncherCliRow value="none" onChange={vi.fn()} yolo={false} onYoloChange={onYoloChange} />);
    expect(screen.queryByRole("switch", { name: "YOLO" })).not.toBeInTheDocument();
  });

  it("classifies YOLO per CLI even before capabilities load", () => {
    expect(resolveYoloSupport("claude", [])).toBe("flag");
    expect(resolveYoloSupport("omp", [])).toBe("flag");
    expect(resolveYoloSupport("pi", [])).toBe("inherent");
    expect(resolveYoloSupport("jcode", [])).toBe("inherent");
    expect(resolveYoloSupport("none", [])).toBe("none");
  });
});

describe("launcherPrefs", () => {
  it("remembers advanced options per CLI and resets them for a CLI without a record", () => {
    saveCliPrefs(createDefaultDraft({ cliTool: "codex", yolo: true, effort: "high", verbose: true }));
    expect(loadCliPrefs("codex")).toMatchObject({ yolo: true, effort: "high", verbose: true, skipMcp: false });
    expect(loadCliPrefs("claude")).toEqual({ yolo: undefined, effort: undefined, verbose: false, skipMcp: false, maxTurns: undefined });
  });
});

describe("LauncherAdvanced", () => {
  it("summarises only the changed options while collapsed", async () => {
    const draft = createDefaultDraft({ cliTool: "claude", effort: "high", skipMcp: true });
    const { result } = renderHook(() => useAdvancedSummary(draft, "wsl"));
    render(
      <LauncherAdvanced summary={result.current} environment={<span>env-row</span>} scenario={null}
        options={null} injection={null} layout={null} preview={null} />,
    );
    const summary = screen.getByTestId("launcher-advanced-summary");
    expect(summary).toHaveTextContent("WSL");
    expect(summary).toHaveTextContent(/思考力度 高|Reasoning/);
    expect(screen.queryByText("env-row")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /高级|Advanced/ }));
    expect(screen.getByText("env-row")).toBeInTheDocument();
  });
});

describe("LauncherProjectPicker", () => {
  it("pre-fills the most recent project so launch is ready straight away", async () => {
    vi.spyOn(historyService, "list").mockResolvedValue([
      { id: 1, projectName: "cc-pane", projectPath: "/code/cc-pane" },
      { id: 2, projectName: "cc-pane", projectPath: "/code/cc-pane" },
    ] as never);
    const onChange = vi.fn();
    await act(async () => {
      render(<LauncherProjectPicker value={null} onChange={onChange} autoSelectRecent />);
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toMatchObject({ kind: "recent", label: "cc-pane" });
  });
});
