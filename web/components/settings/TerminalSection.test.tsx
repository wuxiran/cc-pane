import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellInfo, TerminalSettings } from "@/types";
import TerminalSection from "./TerminalSection";
import { terminalService } from "@/services/terminalService";

vi.mock("@/services/terminalService", () => ({
  terminalService: {
    getAvailableShells: vi.fn().mockResolvedValue([]),
  },
}));

const mockGetAvailableShells = vi.mocked(terminalService.getAvailableShells);

function mockShells(shells: ShellInfo[]) {
  mockGetAvailableShells.mockResolvedValue(shells);
}

function createValue(overrides: Partial<TerminalSettings> = {}): TerminalSettings {
  return {
    fontSize: 15,
    fontFamily: "Consolas",
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 5000,
    themeMode: "followApp",
    rendererMode: "auto",
    showContextUsage: true,
    showStatusBar: true,
    taskQueueEnabled: true,
    pathLinksEnabled: true,
    shell: null,
    disableConptySanitize: null,
    resumeIdBackfillEnabled: null,
    daemonEnabled: false,
    daemonOrphanTtlMinutes: 1440,
    daemonOrphanReaperDisabled: false,
    snapshotApplyKillEnabled: false,
    autoAdoptDaemonSessions: false,
    lowerSessionPriority: true,
    sessionCpuWeight: null,

    splitShortcutPassthrough: false,
    ...overrides,
  };
}

describe("TerminalSection", () => {
  beforeEach(() => {
    mockGetAvailableShells.mockResolvedValue([]);
  });

  it("emits fontSize changes as numbers", () => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const fontSizeInput = screen.getByDisplayValue("15");
    fireEvent.change(fontSizeInput, { target: { value: "18" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 18 }));
  });

  it("clamps fontSize into [10, 32] on blur", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TerminalSection value={createValue({ fontSize: 99 })} onChange={onChange} />);

    fireEvent.blur(screen.getByDisplayValue("99"), { target: { value: "99" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 32 }));

    rerender(<TerminalSection value={createValue({ fontSize: 2 })} onChange={onChange} />);
    fireEvent.blur(screen.getByDisplayValue("2"), { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 10 }));
  });

  it("falls back to 15 when the blurred fontSize is not a number", () => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue({ fontSize: 20 })} onChange={onChange} />);

    fireEvent.blur(screen.getByDisplayValue("20"), { target: { value: "" } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 15 }));
  });

  it("does not emit on blur when the clamped value equals the current one", () => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue({ fontSize: 16 })} onChange={onChange} />);

    fireEvent.blur(screen.getByDisplayValue("16"), { target: { value: "16" } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits theme, cursor style and renderer select changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /终端主题|Terminal theme/i }));
    await user.click(screen.getByRole("option", { name: /深色|Dark/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ themeMode: "dark" }));

    await user.click(screen.getByRole("combobox", { name: /光标样式|Cursor style/i }));
    await user.click(screen.getByRole("option", { name: /竖线|Bar/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cursorStyle: "bar" }));

    await user.click(screen.getByRole("combobox", { name: /渲染器|Renderer/i }));
    await user.click(screen.getByRole("option", { name: /^(尝试|Try) WebGL$/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rendererMode: "webgl" }));
  });

  it("emits showContextUsage changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[1]).toBeChecked();
    await user.click(checkboxes[1]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showContextUsage: false }));
  });

  it("emits terminal path link changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const pathLinks = screen.getByRole("switch", { name: /终端文件路径链接|Terminal file path links/i });
    expect(pathLinks).toBeChecked();
    await user.click(pathLinks);

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pathLinksEnabled: false }));
  });

  it("emits showStatusBar changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    // 顺序：cursorBlink → showContextUsage → showStatusBar → resumeIdBackfillEnabled
    const showStatusBar = screen.getAllByRole("checkbox")[2];
    expect(showStatusBar).toBeChecked();
    await user.click(showStatusBar);

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ showStatusBar: false }));
    // 不应误伤相邻开关
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ showContextUsage: true }));
  });

  it("emits task queue feature changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const taskQueue = screen.getByRole("switch", { name: /任务队列|Task queue/i });
    expect(taskQueue).toBeChecked();
    await user.click(taskQueue);

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ taskQueueEnabled: false }));
  });

  it("emits null when the shell input is cleared", () => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue({ shell: "pwsh" })} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue("pwsh"), { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shell: null }));
  });

  it("renders detected shells as a dropdown and emits the selected id", async () => {
    mockShells([
      { id: "pwsh", name: "PowerShell 7", path: "C:\\pwsh.exe" },
      { id: "cmd", name: "Command Prompt", path: "C:\\Windows\\cmd.exe" },
    ]);
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<TerminalSection value={createValue()} onChange={onChange} />);

    // 等下拉框出现（shell 列表异步加载）
    const shellSelect = await screen.findByRole("combobox", { name: "Shell" });
    await user.click(shellSelect);
    expect(screen.getByRole("option", { name: "PowerShell 7" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Command Prompt" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ shell: "cmd" }));

    rerender(<TerminalSection value={createValue({ shell: "cmd" })} onChange={onChange} />);
    // 选回自动探测 → null
    await user.click(shellSelect);
    await user.click(screen.getByRole("option", { name: /自动检测|Auto-detect/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ shell: null }));
  });

  it("keeps a custom shell value selectable when it is not in the detected list", async () => {
    mockShells([{ id: "pwsh", name: "PowerShell 7", path: "C:\\pwsh.exe" }]);
    const onChange = vi.fn();
    render(
      <TerminalSection value={createValue({ shell: "D:\\tools\\nu.exe" })} onChange={onChange} />,
    );

    const shellSelect = await screen.findByRole("combobox", { name: "Shell" });
    expect(shellSelect).toHaveTextContent("D:\\tools\\nu.exe");
  });

  it("treats a null resumeIdBackfillEnabled as unchecked and toggles it on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    // resumeIdBackfill 是专家项，收在「高级设置」折叠区里（批 5 设置分层）
    await user.click(screen.getByRole("button", { name: /高级设置|Advanced/i }));
    const backfill = screen.getByRole("checkbox", { name: /Resume ID 回填|legacy resume id backfill/i });
    expect(backfill).not.toBeChecked();
    await user.click(backfill);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ resumeIdBackfillEnabled: true }));
  });
});
