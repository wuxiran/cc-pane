import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSettings } from "@/types";
import { DEFAULT_PERFORMANCE_SETTINGS, PERFORMANCE_LIMITS, type PerformanceSettings } from "@/types";
import PerformanceSection from "./PerformanceSection";
import { invokeIfTauri } from "@/services/runtime";
import { toastOk, toastWarn } from "@/lib/feedback";

vi.mock("@/services/runtime", () => ({
  invokeIfTauri: vi.fn(),
  isTauriRuntime: () => false,
}));

vi.mock("@/lib/feedback", () => ({
  toastOk: vi.fn(),
  toastWarn: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeIfTauri);

function createValue(overrides: Partial<PerformanceSettings> = {}): PerformanceSettings {
  return { ...DEFAULT_PERFORMANCE_SETTINGS, ...overrides };
}

function createTerminal(overrides: Partial<TerminalSettings> = {}): TerminalSettings {
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

/** shadcn Slider 的 role="slider" 在 Thumb 上，aria-label 不透传，按根节点 id 定位。 */
function cpuWeightThumb(root: ParentNode): HTMLElement {
  const thumb = root.querySelector('#terminal-session-cpu-weight [role="slider"]');
  if (!(thumb instanceof HTMLElement)) throw new Error("cpu weight slider thumb not rendered");
  return thumb;
}

function renderSection(props: {
  value?: PerformanceSettings;
  terminal?: TerminalSettings;
} = {}) {
  const onChange = vi.fn<(next: PerformanceSettings) => void>();
  const onTerminalChange = vi.fn<(next: TerminalSettings) => void>();
  const utils = render(
    <PerformanceSection
      value={props.value ?? createValue()}
      onChange={onChange}
      terminal={props.terminal ?? createTerminal()}
      onTerminalChange={onTerminalChange}
    />,
  );
  return { ...utils, onChange, onTerminalChange };
}

const SWITCH_IDS: Array<[string, keyof PerformanceSettings]> = [
  ["performance-build-parallelism-enabled", "buildParallelismEnabled"],
  ["performance-codex-lightweight-enabled", "codexLightweightEnabled"],
  ["performance-codex-low-spec-mode", "codexLowSpecMode"],
  ["performance-heavy-gate-enabled", "heavyGateEnabled"],
  ["performance-heavy-ledger-enabled", "heavyLedgerEnabled"],
  ["performance-wsl-quota-enabled", "wslQuotaEnabled"],
];

const NUMBER_IDS: Array<[string, keyof PerformanceSettings]> = [
  ["performance-build-jobs", "buildJobs"],
  ["performance-rg-threads", "rgThreads"],
  ["performance-heavy-gate-slots", "heavyGateSlots"],
  ["performance-heavy-gate-timeout-secs", "heavyGateTimeoutSecs"],
  ["performance-wsl-cpu-weight", "wslCpuWeight"],
  ["performance-wsl-memory-high-percent", "wslMemoryHighPercent"],
  ["performance-parked-terminal-limit", "parkedTerminalLimit"],
  ["performance-park-delay-secs", "parkDelaySecs"],
];

describe("PerformanceSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders every control once", () => {
    const { container } = renderSection();
    for (const [id] of [...SWITCH_IDS, ...NUMBER_IDS]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
    expect(screen.getByRole("checkbox", { name: /降低会话进程优先级|Lower session process priority/i })).toBeInTheDocument();
    expect(cpuWeightThumb(container)).toHaveAttribute("aria-valuemin", "1");
    expect(cpuWeightThumb(container)).toHaveAttribute("aria-valuemax", "9");
    expect(screen.getByRole("button", { name: /清空台账|Clear ledger/i })).toBeInTheDocument();
    // 重负载门禁默认关闭
    expect(container.querySelector("#performance-heavy-gate-enabled")).toHaveAttribute("aria-checked", "false");
  });

  it("emits every switch under its own key", async () => {
    const user = userEvent.setup();
    for (const [id, key] of SWITCH_IDS) {
      const value = createValue();
      const { container, onChange, unmount } = renderSection({ value });
      await user.click(container.querySelector(`#${id}`)!);
      expect(onChange, key).toHaveBeenLastCalledWith({ ...value, [key]: !value[key] });
      unmount();
    }
  });

  it("emits every number field under its own key as a number", () => {
    for (const [id, key] of NUMBER_IDS) {
      const value = createValue({ buildParallelismEnabled: true, heavyGateEnabled: true, wslQuotaEnabled: true });
      const { container, onChange, unmount } = renderSection({ value });
      fireEvent.change(container.querySelector(`#${id}`)!, { target: { value: "7" } });
      expect(onChange, key).toHaveBeenLastCalledWith({ ...value, [key]: 7 });
      unmount();
    }
  });

  it("clamps required numbers into PERFORMANCE_LIMITS on blur and falls back when empty", () => {
    const value = createValue({ parkedTerminalLimit: 99, parkDelaySecs: 1 });
    const { container, onChange } = renderSection({ value });

    fireEvent.blur(container.querySelector("#performance-parked-terminal-limit")!, { target: { value: "99" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ parkedTerminalLimit: PERFORMANCE_LIMITS.parkedTerminalLimit.max }),
    );

    fireEvent.blur(container.querySelector("#performance-park-delay-secs")!, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ parkDelaySecs: PERFORMANCE_LIMITS.parkDelaySecs.min }),
    );

    fireEvent.blur(container.querySelector("#performance-heavy-gate-timeout-secs")!, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ heavyGateTimeoutSecs: DEFAULT_PERFORMANCE_SETTINGS.heavyGateTimeoutSecs }),
    );
  });

  it("does not emit on blur when the value is already within limits", () => {
    const { container, onChange } = renderSection({ value: createValue({ parkDelaySecs: 30 }) });
    fireEvent.blur(container.querySelector("#performance-park-delay-secs")!, { target: { value: "30" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats an empty nullable number as auto (null) and clamps non-empty values on blur", () => {
    const value = createValue({ buildJobs: 16 });
    const { container, onChange } = renderSection({ value });
    const input = container.querySelector("#performance-build-jobs")!;

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, buildJobs: null });

    fireEvent.blur(input, { target: { value: "9999" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, buildJobs: PERFORMANCE_LIMITS.buildJobs.max });

    fireEvent.blur(input, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, buildJobs: PERFORMANCE_LIMITS.buildJobs.min });
  });

  it("disables dependent inputs when their group switch is off", () => {
    const { container } = renderSection({
      value: createValue({ buildParallelismEnabled: false, heavyGateEnabled: false, wslQuotaEnabled: false }),
    });
    expect(container.querySelector("#performance-build-jobs")).toBeDisabled();
    expect(container.querySelector("#performance-heavy-gate-slots")).toBeDisabled();
    expect(container.querySelector("#performance-heavy-gate-timeout-secs")).toBeDisabled();
    expect(container.querySelector("#performance-wsl-cpu-weight")).toBeDisabled();
    expect(container.querySelector("#performance-parked-terminal-limit")).not.toBeDisabled();
  });

  it("moves the lowerSessionPriority checkbox here and keeps it under settings.terminal", async () => {
    const user = userEvent.setup();
    const terminal = createTerminal({ lowerSessionPriority: true });
    const { onChange, onTerminalChange } = renderSection({ terminal });

    const checkbox = screen.getByRole("checkbox", { name: /降低会话进程优先级|Lower session process priority/i });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);

    expect(onTerminalChange).toHaveBeenLastCalledWith({ ...terminal, lowerSessionPriority: false });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("maps the cpu weight slider to settings.terminal.sessionCpuWeight with 5 stored as null", async () => {
    const user = userEvent.setup();
    const terminal = createTerminal({ sessionCpuWeight: null });
    const first = renderSection({ terminal });

    const slider = cpuWeightThumb(first.container);
    expect(slider).toHaveAttribute("aria-valuenow", "5");
    slider.focus();
    await user.keyboard("{ArrowLeft}");
    expect(first.onTerminalChange).toHaveBeenLastCalledWith({ ...terminal, sessionCpuWeight: 4 });
    expect(first.onChange).not.toHaveBeenCalled();
    first.unmount();

    // 从 4 回到中性 5 → 存 null
    const weighted = createTerminal({ sessionCpuWeight: 4 });
    const second = renderSection({ terminal: weighted });
    const back = cpuWeightThumb(second.container);
    expect(back).toHaveAttribute("aria-valuenow", "4");
    back.focus();
    await user.keyboard("{ArrowRight}");
    expect(second.onTerminalChange).toHaveBeenLastCalledWith({ ...weighted, sessionCpuWeight: null });
  });

  it("clears the ledger through the tauri command and toasts on success", async () => {
    mockInvoke.mockResolvedValue(3);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: /清空台账|Clear ledger/i }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("clear_heavy_commands"));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
    expect(toastWarn).not.toHaveBeenCalled();
  });

  it("degrades to a warning toast when the ledger command is missing or fails", async () => {
    const user = userEvent.setup();

    mockInvoke.mockResolvedValue(undefined);
    const first = renderSection();
    await user.click(screen.getByRole("button", { name: /清空台账|Clear ledger/i }));
    await waitFor(() => expect(toastWarn).toHaveBeenCalledTimes(1));
    first.unmount();

    mockInvoke.mockRejectedValue(new Error("command clear_heavy_commands not found"));
    renderSection();
    await user.click(screen.getByRole("button", { name: /清空台账|Clear ledger/i }));
    await waitFor(() => expect(toastWarn).toHaveBeenCalledTimes(2));
    expect(toastOk).not.toHaveBeenCalled();
  });
});
