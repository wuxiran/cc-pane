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
    inlineImagesEnabled: false,
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

    const contextUsage = screen.getByRole("switch", { name: /显示上下文使用量|Show context usage/i });
    expect(contextUsage).toBeChecked();
    await user.click(contextUsage);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showContextUsage: false }));
  });

  it("keeps auto-close off by default and saves explicit color overrides", async () => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);
    const gate = screen.getByRole("switch", { name: /允许完成任务自动收窗|Allow completed tasks/i });
    expect(gate).not.toBeChecked();
    fireEvent.click(gate);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ autoCloseCompletedTasks: true }));
    fireEvent.change(screen.getByLabelText(/^(光标颜色|Cursor color)$/i), { target: { value: "#ffffff" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cursorColor: "#ffffff" }));
  });

  it("renders every boolean as a switch and emits cursorBlink changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const blink = screen.getByRole("switch", { name: /光标闪烁|Cursor Blink/i });
    expect(blink).toBeChecked();
    await user.click(blink);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cursorBlink: false }));
  });

  it("disables orphan reaper controls while the daemon is off", () => {
    render(<TerminalSection value={createValue({ daemonEnabled: false })} onChange={vi.fn()} />);

    expect(screen.getByRole("switch", { name: /永不回收孤儿会话|Never reclaim orphaned sessions/i })).toBeDisabled();
    expect(screen.getByDisplayValue("1440")).toBeDisabled();
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

  it("keeps auto-trust off by default and emits changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const toggle = screen.getByRole("switch", { name: /auto-trust|自动信任/i });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ autoTrustRegisteredProjects: true }),
    );
  });

  it("emits showStatusBar changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const showStatusBar = screen.getByRole("switch", { name: /显示终端状态栏|Show terminal status bar/i });
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

  it("toggles the opt-in inline image feature from its default-off state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    const inlineImages = screen.getByRole("switch", { name: /终端内联图片|Terminal inline images/i });
    // F7.4：beta 能力默认关闭，必须显式开启。
    expect(inlineImages).not.toBeChecked();
    await user.click(inlineImages);

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ inlineImagesEnabled: true }));
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

  it("no longer renders the session priority checkbox (moved to PerformanceSection)", () => {
    const { container } = render(<TerminalSection value={createValue()} onChange={vi.fn()} />);

    expect(container.querySelector("#terminal-lower-session-priority")).toBeNull();
    expect(screen.queryByRole("switch", { name: /降低会话进程优先级|Lower session process priority/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /降低会话进程优先级|Lower session process priority/i })).toBeNull();
  });

  it("treats a null resumeIdBackfillEnabled as unchecked and toggles it on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);

    // resumeIdBackfill 是专家项，平铺在页尾「高级设置」分区（不再折叠）
    expect(screen.getByRole("heading", { name: /高级设置|Advanced/i })).toBeInTheDocument();
    const backfill = screen.getByRole("switch", { name: /Resume ID 回填|legacy resume id backfill/i });
    expect(backfill).not.toBeChecked();
    await user.click(backfill);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ resumeIdBackfillEnabled: true }));
  });
});
