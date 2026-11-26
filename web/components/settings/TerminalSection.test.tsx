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

  it.each([
    { initial: 99, typed: "99", expected: 32 },
    { initial: 2, typed: "2", expected: 10 },
    // 非数字回落到默认 15
    { initial: 20, typed: "", expected: 15 },
  ])("normalizes blurred fontSize $typed to $expected", ({ initial, typed, expected }) => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue({ fontSize: initial })} onChange={onChange} />);

    fireEvent.blur(screen.getByDisplayValue(String(initial)), { target: { value: typed } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: expected }));
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

  // 开关的初始态 + 切换后只改自己的字段（不误伤相邻开关）
  it.each<[RegExp, keyof TerminalSettings, boolean]>([
    [/显示上下文使用量|Show context usage/i, "showContextUsage", true],
    [/光标闪烁|Cursor Blink/i, "cursorBlink", true],
    [/终端文件路径链接|Terminal file path links/i, "pathLinksEnabled", true],
    [/显示终端状态栏|Show terminal status bar/i, "showStatusBar", true],
    [/任务队列|Task queue/i, "taskQueueEnabled", true],
    [/auto-trust|自动信任/i, "autoTrustRegisteredProjects", false],
    [/允许完成任务自动收窗|Allow completed tasks/i, "autoCloseCompletedTasks", false],
    // F7.4：beta 能力默认关闭，必须显式开启。
    [/终端内联图片|Terminal inline images/i, "inlineImagesEnabled", false],
    // resumeIdBackfill 为 null 视为未勾选
    [/Resume ID 回填|legacy resume id backfill/i, "resumeIdBackfillEnabled", false],
  ])("switch %s toggles %s (initially on: %s)", async (name, field, initiallyOn) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = createValue();
    render(<TerminalSection value={value} onChange={onChange} />);

    const toggle = screen.getByRole("switch", { name });
    if (initiallyOn) expect(toggle).toBeChecked();
    else expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(onChange).toHaveBeenLastCalledWith({ ...value, [field]: !initiallyOn });
  });

  it("renders every boolean as a switch and keeps expert items in a flat advanced section", () => {
    render(<TerminalSection value={createValue()} onChange={vi.fn()} />);

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    // resumeIdBackfill 是专家项，平铺在页尾「高级设置」分区（不再折叠）
    expect(screen.getByRole("heading", { name: /高级设置|Advanced/i })).toBeInTheDocument();
  });

  it("saves explicit color overrides", () => {
    const onChange = vi.fn();
    render(<TerminalSection value={createValue()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^(光标颜色|Cursor color)$/i), { target: { value: "#ffffff" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cursorColor: "#ffffff" }));
  });

  it("disables orphan reaper controls while the daemon is off", () => {
    render(<TerminalSection value={createValue({ daemonEnabled: false })} onChange={vi.fn()} />);

    expect(screen.getByRole("switch", { name: /永不回收孤儿会话|Never reclaim orphaned sessions/i })).toBeDisabled();
    expect(screen.getByDisplayValue("1440")).toBeDisabled();
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
  });
});
