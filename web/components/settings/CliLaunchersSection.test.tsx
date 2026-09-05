import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { toast } from "sonner";
import { settingsService } from "@/services";
import { useCliTools } from "@/hooks/useCliTools";
import type { CliLauncherSettings, CliToolInfo } from "@/types";
import CliLaunchersSection from "./CliLaunchersSection";

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: vi.fn(),
}));

vi.mock("@/services/settingsService", () => ({
  settingsService: {
    testCliLauncher: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function createTool(overrides: Partial<CliToolInfo> = {}): CliToolInfo {
  return {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    installed: true,
    path: "C:/bin/claude.cmd",
    version: "1.0.0",
    versionArgs: ["--version"],
    ...overrides,
  } as CliToolInfo;
}

function mockTools(tools: CliToolInfo[], loading = false) {
  vi.mocked(useCliTools).mockReturnValue({
    tools,
    loading,
    refresh: vi.fn(),
    getToolById: (id: string) => tools.find((t) => t.id === id),
    installedTools: tools.filter((t) => t.installed),
  });
}

async function selectTool(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", {
    name: i18n.t("settings:cliToolSelect"),
  }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", {
    name: new RegExp(label),
  }));
}

describe("CliLaunchersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTools([createTool()]);
  });

  it("shows a skeleton after the delay while tools are being fetched", () => {
    vi.useFakeTimers();
    try {
      mockTools([], true);
      render(<CliLaunchersSection value={{ overrides: {} }} onChange={vi.fn()} />);

      // 300ms 内不显示骨架，避免快加载闪占位
      expect(screen.queryByTestId("cli-launchers-skeleton")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByTestId("cli-launchers-skeleton")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows one selected tool and switches it from the CLI dropdown", async () => {
    const user = userEvent.setup();
    mockTools([
      createTool(),
      createTool({ id: "codex", displayName: "Codex CLI", executable: "codex", installed: false, path: null as unknown as string }),
    ]);
    render(<CliLaunchersSection value={{ overrides: {} }} onChange={vi.fn()} />);

    const editor = screen.getByTestId("cli-launcher-editor");
    expect(editor).toHaveAttribute("data-cli-tool", "claude");
    expect(editor).toHaveTextContent("Claude Code");
    expect(editor).toHaveTextContent("C:/bin/claude.cmd");
    expect(editor).not.toHaveTextContent("Codex CLI");

    await selectTool(user, "Codex CLI");
    expect(editor).toHaveAttribute("data-cli-tool", "codex");
    expect(editor).toHaveTextContent("Codex CLI");
    expect(editor).toHaveTextContent(i18n.t("settings:cliNotInstalled"));
    expect(editor).not.toHaveTextContent("Claude Code");
  });

  it("adds an override when a custom command is typed", () => {
    const onChange = vi.fn();
    render(<CliLaunchersSection value={{ overrides: {} }} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText("claude"), {
      target: { value: "node C:/dev/claude.js" },
    });

    expect(onChange).toHaveBeenCalledWith({
      overrides: { claude: { command: "node C:/dev/claude.js" } },
    });
  });

  it("removes the override when the command is cleared or reset", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: CliLauncherSettings = { overrides: { claude: { command: "custom" } } };
    render(<CliLaunchersSection value={value} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue("custom"), { target: { value: "   " } });
    expect(onChange).toHaveBeenLastCalledWith({ overrides: {} });

    const resetButton = screen.getByRole("button", {
      name: i18n.t("settings:cliLauncherReset"),
    });
    await user.click(resetButton);
    expect(onChange).toHaveBeenLastCalledWith({ overrides: {} });
  });

  it("disables reset when there is no override", () => {
    render(<CliLaunchersSection value={{ overrides: {} }} onChange={vi.fn()} />);

    expect(screen.getByRole("button", {
      name: i18n.t("settings:cliLauncherReset"),
    })).toBeDisabled();
  });

  it("tests the override command and reports success", async () => {
    const user = userEvent.setup();
    vi.mocked(settingsService.testCliLauncher).mockResolvedValue("claude 1.0.0" as never);
    render(
      <CliLaunchersSection
        value={{ overrides: { claude: { command: "my-claude" } } }}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", {
      name: i18n.t("settings:cliLauncherTest"),
    }));

    await waitFor(() =>
      expect(settingsService.testCliLauncher).toHaveBeenCalledWith("my-claude", ["--version"]),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("falls back to the executable and --version when nothing is overridden", async () => {
    const user = userEvent.setup();
    mockTools([createTool({ versionArgs: [] })]);
    vi.mocked(settingsService.testCliLauncher).mockRejectedValue(new Error("not found"));
    render(<CliLaunchersSection value={{ overrides: {} }} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", {
      name: i18n.t("settings:cliLauncherTest"),
    }));

    await waitFor(() =>
      expect(settingsService.testCliLauncher).toHaveBeenCalledWith("claude", ["--version"]),
    );
    expect(toast.error).toHaveBeenCalled();
  });
});
